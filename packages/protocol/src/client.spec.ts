import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IntegrationClient, IntegrationError } from './client.js';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from './signature.js';

type Handler = (req: IncomingMessage, body: string) => { status: number; body?: unknown; headers?: Record<string, string>; delayMs?: number };

const SECRET = 'test-secret';
let server: Server;
let baseUrl: string;
let handler: Handler;
const seen: Array<{ method: string; url: string; body: string; idempotencyKey?: string }> = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const verified = verifySignature({
        secret: SECRET,
        method: req.method!,
        path: req.url!,
        body,
        timestamp: req.headers[TIMESTAMP_HEADER],
        signature: req.headers[SIGNATURE_HEADER],
      });
      seen.push({ method: req.method!, url: req.url!, body, idempotencyKey: req.headers['idempotency-key'] as string | undefined });
      const reply = verified.ok ? handler(req, body) : { status: 401, body: { error: { code: 'invalid_signature', message: verified.reason } } };
      setTimeout(() => {
        res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
        res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/support`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const client = () => new IntegrationClient({ baseUrl, secret: SECRET, timeoutMs: 300 });
const manifest = { protocol_version: 1, name: 'coffee', title: 'Coffee shop' };

describe('IntegrationClient', () => {
  it('signs a request with a path prefix, parses the manifest and ETag, 304 on If-None-Match', async () => {
    handler = (req) => (req.headers['if-none-match'] === '"v1"' ? { status: 304 } : { status: 200, body: manifest, headers: { etag: '"v1"' } });

    const first = await client().manifest();
    const second = await client().manifest('"v1"');

    expect(first).toMatchObject({ notModified: false, etag: '"v1"', manifest: { name: 'coffee', tools: [] } });
    expect(second).toEqual({ notModified: true });
    expect(seen.at(-1)!.url).toBe('/api/support/manifest');
  });

  it('execute passes Idempotency-Key and a body with customer_ref', async () => {
    handler = () => ({ status: 200, body: { status: 'executed', external_ref: 'acc-1' } });

    const result = await client().execute('accrue_points', 'g1', { amount: 19 }, 'key-1');

    expect(result).toEqual({ status: 'executed', external_ref: 'acc-1' });
    expect(seen.at(-1)).toMatchObject({ url: '/api/support/actions/accrue_points/execute', idempotencyKey: 'key-1' });
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ customer_ref: 'g1', params: { amount: 19 } });
  });

  it('protocol errors: the code comes from the body, retryable only for 5xx; a response off the schema — invalid_response', async () => {
    handler = () => ({ status: 422, body: { error: { code: 'invalid_arguments', message: 'amount: required' } } });
    await expect(client().validate('accrue_points', 'g1', {})).rejects.toMatchObject({ code: 'invalid_arguments', status: 422, retryable: false });

    handler = () => ({ status: 503, body: { error: { code: 'internal', message: 'db down' } } });
    await expect(client().resolve({ phone: '79000000001' })).rejects.toMatchObject({ code: 'internal', retryable: true });

    handler = () => ({ status: 200, body: { status: 'maybe' } });
    await expect(client().resolve({ phone: '79000000001' })).rejects.toMatchObject({ code: 'invalid_response', retryable: false });
  });

  it('timeout and unavailability are retryable', async () => {
    handler = () => ({ status: 200, body: { status: 'not_found' }, delayMs: 1000 });
    const error = await client().resolve({ phone: '79000000001' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntegrationError);
    expect(error).toMatchObject({ code: 'timeout', retryable: true });

    const offline = new IntegrationClient({ baseUrl: 'http://127.0.0.1:1/api', secret: SECRET, timeoutMs: 300 });
    await expect(offline.context('g1')).rejects.toMatchObject({ code: 'network', retryable: true });
  });

  it('a response that is too large is an error', async () => {
    handler = () => ({ status: 200, body: { data: 'x'.repeat(2000) } });
    const small = new IntegrationClient({ baseUrl, secret: SECRET, maxResponseBytes: 1000 });
    await expect(small.callTool('get_coupons', 'g1', {})).rejects.toMatchObject({ code: 'response_too_large' });
  });
});
