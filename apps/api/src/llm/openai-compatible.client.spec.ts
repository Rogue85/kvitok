import { describe, expect, it, vi } from 'vitest';
import { LlmError } from './llm.types';
import { OpenAiCompatibleClient } from './openai-compatible.client';

function fakeFetch(...responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    const next = responses.shift()!;
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), { status: next.status });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const okBody = {
  choices: [
    {
      message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'submit_result', arguments: '{"a":1}' } }] },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 120, completion_tokens: 30 },
};

describe('OpenAiCompatibleClient', () => {
  it('sends messages and tools in the OpenAI format and parses tool_calls', async () => {
    const { fn, calls } = fakeFetch({ status: 200, body: okBody });
    const client = new OpenAiCompatibleClient({ baseUrl: 'http://llm.local/v1/', apiKey: 'sk-test', fetchImpl: fn });

    const response = await client.chat({
      model: 'm',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'assistant', content: null, toolCalls: [{ id: 'x', name: 'read_playbook', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'x', content: 'body' },
      ],
      tools: [{ name: 'submit_result', description: 'd', parameters: { type: 'object' } }],
      toolChoice: { name: 'submit_result' },
      maxTokens: 500,
    });

    expect(calls[0]!.url).toBe('http://llm.local/v1/chat/completions');
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-test');
    expect(calls[0]!.body).toMatchObject({
      model: 'm',
      max_tokens: 500,
      tool_choice: { type: 'function', function: { name: 'submit_result' } },
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'assistant', tool_calls: [{ id: 'x', type: 'function', function: { name: 'read_playbook' } }] },
        { role: 'tool', tool_call_id: 'x', content: 'body' },
      ],
    });
    expect(response).toEqual({
      content: null,
      toolCalls: [{ id: 'c1', name: 'submit_result', arguments: '{"a":1}' }],
      finishReason: 'tool_calls',
      usage: { input: 120, output: 30 },
    });
  });

  it('uses max_completion_tokens for api.openai.com', async () => {
    const { fn, calls } = fakeFetch({ status: 200, body: okBody });
    await new OpenAiCompatibleClient({ baseUrl: 'https://api.openai.com/v1', fetchImpl: fn }).chat({ model: 'm', messages: [], maxTokens: 10 });
    expect(calls[0]!.body).toMatchObject({ max_completion_tokens: 10 });
    expect(calls[0]!.body).not.toHaveProperty('max_tokens');
  });

  it('retries on 429/5xx and does not retry on 400', async () => {
    vi.useFakeTimers();
    const retry = fakeFetch({ status: 429, body: 'slow down' }, { status: 200, body: okBody });
    const promise = new OpenAiCompatibleClient({ baseUrl: 'http://llm.local', fetchImpl: retry.fn }).chat({ model: 'm', messages: [] });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toMatchObject({ usage: { input: 120 } });
    expect(retry.calls).toHaveLength(2);
    vi.useRealTimers();

    const bad = fakeFetch({ status: 400, body: 'bad request' });
    await expect(new OpenAiCompatibleClient({ baseUrl: 'http://llm.local', fetchImpl: bad.fn }).chat({ model: 'm', messages: [] })).rejects.toBeInstanceOf(LlmError);
    expect(bad.calls).toHaveLength(1);
  });
});
