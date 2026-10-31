import type { LlmClient } from './llm.types';
import { OpenAiCompatibleClient } from './openai-compatible.client';

export const LLM_CLIENT_FACTORY = Symbol('LLM_CLIENT_FACTORY');

export interface ResolvedLlmProvider {
  id: string;
  kind: string;
  baseUrl: string;
  apiKey: string | null;
  headers?: Record<string, string>;
}

/** Creates a client for the provider. Replaced with a scripted mock in tests. */
export type LlmClientFactory = (provider: ResolvedLlmProvider) => LlmClient;

export const defaultLlmClientFactory: LlmClientFactory = (provider) => {
  if (provider.kind !== 'openai_compatible') {
    throw new Error(`Unsupported LLM provider kind: ${provider.kind}`);
  }
  return new OpenAiCompatibleClient({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey ?? undefined,
    headers: provider.headers,
  });
};
