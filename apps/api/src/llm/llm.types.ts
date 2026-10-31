export interface LlmToolCall {
  id: string;
  name: string;
  /** JSON string of the arguments, as the model returned it. */
  arguments: string;
}

export type LlmMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface LlmTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
  tools?: LlmTool[];
  /** auto | required | none (tools stay defined, the model answers with text) | name of the tool to call. */
  toolChoice?: 'auto' | 'required' | 'none' | { name: string };
  temperature?: number;
  maxTokens?: number;
  /** Ask the model for a JSON object (mode without tools). */
  jsonMode?: boolean;
  signal?: AbortSignal;
}

export interface LlmResponse {
  content: string | null;
  toolCalls: LlmToolCall[];
  finishReason: string | null;
  usage: { input: number; output: number };
}

export interface LlmClient {
  chat(request: LlmRequest): Promise<LlmResponse>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}
