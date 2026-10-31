import type { LlmClient, LlmRequest, LlmResponse } from '../../src/llm/llm.types';

type ScriptItem = LlmResponse | ((request: LlmRequest) => LlmResponse | Promise<LlmResponse>);

let callCounter = 0;

/** A scripted LLM: answers with predefined responses and records the requests. */
export class ScriptedLlm implements LlmClient {
  readonly requests: LlmRequest[] = [];

  constructor(private readonly script: ScriptItem[] = []) {}

  push(...items: ScriptItem[]): this {
    this.script.push(...items);
    return this;
  }

  async chat(request: LlmRequest): Promise<LlmResponse> {
    request.signal?.throwIfAborted();
    this.requests.push({ ...request, messages: [...request.messages] });
    const next = this.script.shift();
    if (next === undefined) {
      throw new Error('ScriptedLlm: script exhausted');
    }
    return typeof next === 'function' ? next(request) : next;
  }
}

export function toolCall(name: string, args: unknown, usage = { input: 100, output: 20 }): LlmResponse {
  callCounter += 1;
  return {
    content: null,
    toolCalls: [{ id: `call_${callCounter}`, name, arguments: JSON.stringify(args) }],
    finishReason: 'tool_calls',
    usage,
  };
}

export function text(content: string): LlmResponse {
  return { content, toolCalls: [], finishReason: 'stop', usage: { input: 50, output: 10 } };
}

export function result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    department: null,
    confidence: 0.9,
    routing_reason: 'по теме',
    alternative_department: null,
    summary: 'Клиент не получил баллы за покупку',
    findings: [],
    fields: {},
    reply: { needed: true, body: 'Добрый день!\n\nПроверим и вернёмся с ответом.' },
    needs_human: false,
    questions_for_operator: [],
    playbooks_used: [],
    ...overrides,
  };
}
