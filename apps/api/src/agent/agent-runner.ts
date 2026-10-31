import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { LlmClient, LlmMessage, LlmRequest, LlmToolCall } from '../llm/llm.types';
import type { AssembledContext } from './context-assembler';
import type { AgentConfigSnapshot } from './config-snapshot.service';
import type { ToolExecutor } from './integration-runtime';
import { findLeakedMarkup, READ_PLAYBOOK, resultSchema, type AgentResult } from './submit-schema';

const MAX_REPAIRS = 2;

export interface RunnerStep {
  kind: 'llm' | 'tool';
  name: string | null;
  input: unknown;
  output: unknown;
  error: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number;
}

export interface RunnerInput {
  client: LlmClient;
  model: string;
  snapshot: AgentConfigSnapshot;
  context: AssembledContext;
  signal?: AbortSignal;
  onStep?: (step: RunnerStep) => Promise<void> | void;
  /** Integration tools: reading customer data. */
  tools?: ToolExecutor;
}

export interface RunnerOutput<T> {
  result: T;
  usage: { input: number; output: number };
}

export class AgentRunError extends Error {}

/**
 * Tool loop: the model reads playbooks and finishes the analysis by calling submit_*.
 * An invalid result goes back to the model with the errors (up to two attempts to fix). The fix comes as a JSON object
 * in the message text: some providers corrupt long tool-call arguments on the way (their call markup leaks into the
 * strings), and a repeated call fails the same way, while text does not go through that translation.
 * Without tool support — a single JSON answer in content.
 */
@Injectable()
export class AgentRunner {
  async run(input: RunnerInput): Promise<RunnerOutput<AgentResult>> {
    const { context, snapshot } = input;
    const schema: z.ZodType<AgentResult> = resultSchema(snapshot.departments.map((d) => d.key), { partial: context.partial, fieldKeys: context.agentFields.map((f) => f.key) });
    const messages: LlmMessage[] = [...context.messages];
    const usage = { input: 0, output: 0 };
    const supportsTools = context.tools.length > 0;
    let toolCalls = 0;
    let repairs = 0;
    let forceSubmit = false;
    /** After an invalid submit: the result is expected as JSON in the message text, tools stay defined but unused. */
    let submitAsText = false;
    const resultKeys = Object.keys((context.tools.find((t) => t.name === context.submitTool)?.parameters.properties ?? {}) as object);

    const callLlm = async () => {
      input.signal?.throwIfAborted();
      const started = Date.now();
      const onlySubmit = forceSubmit || toolCalls >= snapshot.settings.maxToolCalls;
      const tools = onlySubmit ? context.tools.filter((t) => t.name === context.submitTool) : context.tools;
      const toolChoice: LlmRequest['toolChoice'] = submitAsText ? 'none' : onlySubmit ? { name: context.submitTool } : 'auto';
      const request: LlmRequest = {
        model: input.model,
        messages,
        ...(supportsTools ? { tools, toolChoice } : { jsonMode: true }),
        temperature: snapshot.settings.temperature,
        maxTokens: snapshot.settings.maxOutputTokens,
        signal: input.signal,
      };
      try {
        const response = await input.client.chat(request);
        usage.input += response.usage.input;
        usage.output += response.usage.output;
        await input.onStep?.({
          kind: 'llm',
          name: input.model,
          input: { messages: messages.length, tools: tools.map((t) => t.name), toolChoice: request.toolChoice ?? null },
          output: { content: response.content, toolCalls: response.toolCalls, finishReason: response.finishReason },
          error: null,
          tokensIn: response.usage.input,
          tokensOut: response.usage.output,
          durationMs: Date.now() - started,
        });
        return response;
      } catch (error) {
        await input.onStep?.({
          kind: 'llm',
          name: input.model,
          input: { messages: messages.length },
          output: null,
          error: error instanceof Error ? error.message : String(error),
          tokensIn: null,
          tokensOut: null,
          durationMs: Date.now() - started,
        });
        throw error;
      }
    };

    const tryParse = (raw: unknown): { ok: true; value: AgentResult } | { ok: false; error: string } => {
      // Call markup inside a string — the model lost track of the arguments; the schema would accept it, but the data would be corrupted.
      const leaked = findLeakedMarkup(raw, resultKeys);
      if (leaked) {
        return { ok: false, error: `${leaked}: tool-call markup or other fields leaked into the value; every field must be a separate JSON field` };
      }
      const parsed = schema.safeParse(raw);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
    };

    for (let iteration = 0; iteration < snapshot.settings.maxToolCalls + MAX_REPAIRS + 3; iteration += 1) {
      const response = await callLlm();
      if (response.finishReason === 'length' && response.toolCalls.every((call) => !isCompleteJson(call.arguments)) && !isCompleteJson(response.content)) {
        // A retry would hit the same limit: reasoning models spend it on reasoning too.
        throw new AgentRunError(
          t('api.agent.truncated', { limit: snapshot.settings.maxOutputTokens }),
        );
      }

      if (!supportsTools) {
        const parsed = tryParse(extractJson(response.content));
        if (parsed.ok) return { result: parsed.value, usage };
        if (repairs >= MAX_REPAIRS) throw new AgentRunError(t('api.agent.invalidJson', { error: parsed.error }));
        repairs += 1;
        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'user', content: `The reply failed validation: ${parsed.error}. Return the whole corrected JSON object.` });
        continue;
      }

      messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });

      if (submitAsText && response.toolCalls.length === 0) {
        const parsed = tryParse(extractJson(response.content));
        await input.onStep?.({
          kind: 'tool',
          name: context.submitTool,
          input: { text: response.content },
          output: parsed.ok ? 'accepted from text' : null,
          error: parsed.ok ? null : parsed.error,
          tokensIn: null,
          tokensOut: null,
          durationMs: 0,
        });
        if (parsed.ok) return { result: parsed.value, usage };
        repairs += 1;
        if (repairs > MAX_REPAIRS) throw new AgentRunError(t('api.agent.invalidSubmit', { tool: context.submitTool, error: parsed.error }));
        messages.push({ role: 'user', content: `The JSON failed validation: ${parsed.error}. ${textResultRequest(context.submitTool)}` });
        continue;
      }

      if (response.toolCalls.length === 0) {
        // A finished result written as text instead of a call is a result all the same.
        const asText = extractJson(response.content);
        if (asText !== undefined) {
          const parsed = tryParse(asText);
          if (parsed.ok) return { result: parsed.value, usage };
        }
        if (repairs >= MAX_REPAIRS) throw new AgentRunError(t('api.agent.noSubmit'));
        repairs += 1;
        forceSubmit = true;
        messages.push({ role: 'user', content: `Finish with a ${context.submitTool} call.` });
        continue;
      }

      // The model sometimes calls submit several times in one response: take the first valid one and count one repair attempt per response.
      let submitted: AgentResult | null = null;
      let invalid: string | null = null;
      for (const call of response.toolCalls) {
        const outcome = await this.handleToolCall(call, context, snapshot, tryParse, input.onStep, input.tools);
        if (outcome.kind === 'submitted') {
          submitted = outcome.value;
          break;
        }
        if (outcome.kind === 'invalid') {
          invalid ??= outcome.error;
        } else {
          toolCalls += 1;
        }
        messages.push({ role: 'tool', toolCallId: call.id, content: outcome.content });
      }
      if (submitted) return { result: submitted, usage };
      if (invalid !== null) {
        repairs += 1;
        if (repairs > MAX_REPAIRS) throw new AgentRunError(t('api.agent.invalidSubmit', { tool: context.submitTool, error: invalid }));
        submitAsText = true;
        messages.push({ role: 'user', content: `Do not call ${context.submitTool} again. ${textResultRequest(context.submitTool)}` });
        continue;
      }
      if (toolCalls >= snapshot.settings.maxToolCalls) {
        messages.push({ role: 'user', content: `The tool limit is used up. Finish the analysis with a ${context.submitTool} call using the data you have.` });
      }
    }
    throw new AgentRunError(t('api.agent.tooManySteps'));
  }

  private async handleToolCall(
    call: LlmToolCall,
    context: AssembledContext,
    snapshot: AgentConfigSnapshot,
    tryParse: (raw: unknown) => { ok: true; value: AgentResult } | { ok: false; error: string },
    onStep: RunnerInput['onStep'],
    tools: ToolExecutor | undefined,
  ): Promise<
    | { kind: 'submitted'; value: AgentResult }
    | { kind: 'invalid'; error: string; content: string }
    | { kind: 'tool'; content: string }
  > {
    const started = Date.now();
    let args: unknown;
    try {
      args = JSON.parse(call.arguments || '{}');
    } catch {
      args = undefined;
    }

    if (call.name === context.submitTool) {
      const parsed = args === undefined ? { ok: false as const, error: 'the arguments are not JSON' } : tryParse(args);
      await onStep?.({
        kind: 'tool',
        name: call.name,
        input: args ?? call.arguments,
        output: parsed.ok ? 'accepted' : null,
        error: parsed.ok ? null : parsed.error,
        tokensIn: null,
        tokensOut: null,
        durationMs: Date.now() - started,
      });
      return parsed.ok
        ? { kind: 'submitted', value: parsed.value }
        : { kind: 'invalid', error: parsed.error, content: `Validation error: ${parsed.error}.` };
    }

    if (tools?.has(call.name)) {
      const execution = await tools.execute(call.name, args);
      await onStep?.({
        kind: 'tool',
        name: call.name,
        input: execution.stepInput,
        output: execution.stepOutput,
        error: execution.error,
        tokensIn: null,
        tokensOut: null,
        durationMs: Date.now() - started,
      });
      return { kind: 'tool', content: execution.content };
    }

    let content: string;
    let error: string | null = null;
    if (call.name === READ_PLAYBOOK) {
      const key = (args as { key?: string } | undefined)?.key;
      const playbook = snapshot.playbooks.find((p) => p.key === key);
      content = playbook ? `# ${playbook.title}\nWhen: ${playbook.when}\n\n${playbook.body}` : `Playbook "${key}" not found. Available: ${context.playbookKeys.join(', ')}`;
      if (!playbook) error = 'not found';
    } else {
      content = `Tool ${call.name} is unavailable.`;
      error = 'unknown tool';
    }
    await onStep?.({ kind: 'tool', name: call.name, input: args ?? call.arguments, output: content, error, tokensIn: null, tokensOut: null, durationMs: Date.now() - started });
    return { kind: 'tool', content };
  }
}

function textResultRequest(submitTool: string): string {
  return `Reply with the whole corrected result as one JSON object in the message text: the same fields as the ${submitTool} arguments, each a separate JSON field, nothing around it.`;
}

function isCompleteJson(text: string | null): boolean {
  if (!text) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** A JSON object from the model's answer: the whole answer or the first {...} (models like to wrap it in text and ```). */
export function extractJson(content: string | null): unknown {
  if (!content) return undefined;
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}
