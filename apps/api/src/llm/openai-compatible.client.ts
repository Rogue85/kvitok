import { t } from '@kvitok/i18n';
import { LlmError, type LlmClient, type LlmMessage, type LlmRequest, type LlmResponse } from './llm.types';

const REQUEST_TIMEOUT_MS = 120_000;
const RETRY_DELAYS_MS = [1_000, 3_000];

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

/** Client for `POST {baseUrl}/chat/completions` — OpenAI, OpenRouter, LiteLLM, vLLM, Ollama. */
export class OpenAiCompatibleClient implements LlmClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async chat(request: LlmRequest): Promise<LlmResponse> {
    const body = this.toBody(request);
    let lastError: unknown;

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      if (attempt > 0) {
        await sleep(RETRY_DELAYS_MS[attempt - 1]!, request.signal);
      }
      try {
        return await this.send(body, request.signal);
      } catch (error) {
        lastError = error;
        if (!(error instanceof LlmError) || !error.retryable || request.signal?.aborted) {
          throw error;
        }
      }
    }
    throw lastError;
  }

  private async send(body: unknown, signal?: AbortSignal): Promise<LlmResponse> {
    const url = `${this.options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(signal ? [signal] : [])];
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
          ...this.options.headers,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new LlmError(t('api.llm.cancelled'), null, false);
      }
      throw new LlmError(t('api.llm.network', { error: error instanceof Error ? error.message : String(error) }), null, true);
    }

    const text = await response.text();
    if (!response.ok) {
      throw new LlmError(
        `LLM HTTP ${response.status}: ${text.slice(0, 500)}`,
        response.status,
        response.status === 429 || response.status >= 500,
      );
    }

    let json: OpenAiResponse;
    try {
      json = JSON.parse(text) as OpenAiResponse;
    } catch {
      throw new LlmError(t('api.llm.notJson', { body: text.slice(0, 200) }), response.status, false);
    }
    const choice = json.choices?.[0];
    if (!choice) {
      throw new LlmError(t('api.llm.noChoices', { body: text.slice(0, 200) }), response.status, false);
    }
    return {
      content: choice.message?.content ?? null,
      toolCalls: (choice.message?.tool_calls ?? []).map((call, index) => ({
        id: call.id ?? `call_${index}`,
        name: call.function?.name ?? '',
        arguments: call.function?.arguments ?? '{}',
      })),
      finishReason: choice.finish_reason ?? null,
      usage: { input: json.usage?.prompt_tokens ?? 0, output: json.usage?.completion_tokens ?? 0 },
    };
  }

  private toBody(request: LlmRequest): Record<string, unknown> {
    // Newer OpenAI models accept only max_completion_tokens, compatible servers — max_tokens.
    const maxTokensKey = /api\.openai\.com/.test(this.options.baseUrl) ? 'max_completion_tokens' : 'max_tokens';
    return {
      model: request.model,
      messages: request.messages.map(toOpenAiMessage),
      ...(request.tools?.length
        ? {
            tools: request.tools.map((tool) => ({
              type: 'function',
              function: { name: tool.name, description: tool.description, parameters: tool.parameters },
            })),
            tool_choice:
              typeof request.toolChoice === 'object'
                ? { type: 'function', function: { name: request.toolChoice.name } }
                : (request.toolChoice ?? 'auto'),
          }
        : {}),
      ...(request.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxTokens === undefined ? {} : { [maxTokensKey]: request.maxTokens }),
    };
  }
}

function toOpenAiMessage(message: LlmMessage): Record<string, unknown> {
  switch (message.role) {
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      };
    default:
      return { role: message.role, content: message.content };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

interface OpenAiResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}
