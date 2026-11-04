import type { z } from 'zod';
import {
  ContextResponseSchema,
  DataResultSchema,
  ErrorResponseSchema,
  ExecuteResponseSchema,
  ExecutionStatusResponseSchema,
  ManifestSchema,
  OptionSetResponseSchema,
  PROTOCOL_PATHS,
  ResolveResponseSchema,
  ValidateResponseSchema,
  type ContextResponse,
  type DataResult,
  type ExecuteResponse,
  type ExecutionContext,
  type ExecutionStatusResponse,
  type Manifest,
  type OptionSetResponse,
  type ResolveResponse,
  type ValidateResponse,
} from './schemas.js';
import { IDEMPOTENCY_HEADER, signatureHeaders } from './signature.js';

export interface IntegrationClientOptions {
  /** Base URL of the integration, may include a path prefix: `https://example.com/api/support`. */
  baseUrl: string;
  secret: string;
  /** Timeout of a single request. */
  timeoutMs?: number;
  /** A larger response is a `response_too_large` error. */
  maxResponseBytes?: number;
  fetch?: typeof fetch;
}

/**
 * An integration call error.
 * `retryable` — a temporary failure (network, timeout, 5xx): a read can be retried, for execute ask for the execution status.
 */
export class IntegrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'IntegrationError';
  }
}

export type ManifestFetchResult = { notModified: true } | { notModified: false; manifest: Manifest; etag: string | null };
export type OptionSetFetchResult = { notModified: true } | { notModified: false; options: OptionSetResponse['options']; etag: string | null };

/** A full directory is larger than a usual response: up to 1,000 options with descriptions. */
const OPTION_SET_MAX_BYTES = 2_000_000;

/** Support Action Protocol client: signs requests and validates responses with the schemas. */
export class IntegrationClient {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: IntegrationClientOptions) {
    this.baseUrl = new URL(options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`);
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 1_000_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** With `etag` the backend may respond 304 — the manifest has not changed. */
  async manifest(etag?: string | null): Promise<ManifestFetchResult> {
    const response = await this.send('GET', PROTOCOL_PATHS.manifest, undefined, etag ? { 'if-none-match': etag } : {});
    if (response.status === 304) {
      return { notModified: true };
    }
    const manifest = await this.parse(response, ManifestSchema);
    return { notModified: false, manifest, etag: response.headers.get('etag') };
  }

  /** The options of a directory declared in the manifest; with `etag` the backend may respond 304. */
  async optionSet(name: string, etag?: string | null): Promise<OptionSetFetchResult> {
    const response = await this.send('GET', PROTOCOL_PATHS.optionSet(name), undefined, etag ? { 'if-none-match': etag } : {});
    if (response.status === 304) {
      return { notModified: true };
    }
    const set = await this.parse(response, OptionSetResponseSchema, Math.max(this.maxResponseBytes, OPTION_SET_MAX_BYTES));
    return { notModified: false, options: set.options, etag: response.headers.get('etag') };
  }

  resolve(identities: Record<string, string>): Promise<ResolveResponse> {
    return this.call('POST', PROTOCOL_PATHS.resolve, { identities }, ResolveResponseSchema);
  }

  context(customerRef: string): Promise<ContextResponse> {
    return this.call('POST', PROTOCOL_PATHS.context, { customer_ref: customerRef }, ContextResponseSchema);
  }

  callTool(name: string, customerRef: string | null, args: Record<string, unknown>): Promise<DataResult> {
    return this.call('POST', PROTOCOL_PATHS.tool(name), { customer_ref: customerRef, args }, DataResultSchema);
  }

  validate(action: string, customerRef: string, params: Record<string, unknown>): Promise<ValidateResponse> {
    return this.call('POST', PROTOCOL_PATHS.validate(action), { customer_ref: customerRef, params }, ValidateResponseSchema);
  }

  /**
   * A repeat with the same key returns the previous result and does not execute the action again.
   * `context` — who started it, for the backend's audit; not part of the idempotency fingerprint.
   */
  execute(
    action: string,
    customerRef: string,
    params: Record<string, unknown>,
    idempotencyKey: string,
    context?: ExecutionContext,
  ): Promise<ExecuteResponse> {
    return this.call('POST', PROTOCOL_PATHS.execute(action), { customer_ref: customerRef, params, ...(context ? { context } : {}) }, ExecuteResponseSchema, {
      [IDEMPOTENCY_HEADER]: idempotencyKey,
    });
  }

  executionStatus(idempotencyKey: string): Promise<ExecutionStatusResponse> {
    return this.call('GET', PROTOCOL_PATHS.execution(idempotencyKey), undefined, ExecutionStatusResponseSchema);
  }

  private async call<S extends z.ZodType>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    schema: S,
    headers: Record<string, string> = {},
  ): Promise<z.infer<S>> {
    return this.parse(await this.send(method, path, body, headers), schema);
  }

  private async send(method: 'GET' | 'POST', path: string, body: unknown, headers: Record<string, string>): Promise<Response> {
    const url = new URL(path.replace(/^\//, ''), this.baseUrl);
    const payload = body === undefined ? '' : JSON.stringify(body);
    try {
      return await this.fetchImpl(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...signatureHeaders({ secret: this.options.secret, method, path: url.pathname + url.search, body: payload }),
          ...headers,
        },
        body: body === undefined ? undefined : payload,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new IntegrationError(
        timeout ? 'timeout' : 'network',
        timeout ? `The integration did not respond within ${this.timeoutMs} ms` : `The integration is unavailable: ${(error as Error).message}`,
        null,
        true,
      );
    }
  }

  private async parse<S extends z.ZodType>(response: Response, schema: S, maxBytes = this.maxResponseBytes): Promise<z.infer<S>> {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new IntegrationError('response_too_large', `The response is larger than ${maxBytes} bytes`, response.status, false);
    }
    let json: unknown;
    try {
      json = text === '' ? undefined : JSON.parse(text);
    } catch {
      throw new IntegrationError('invalid_response', `The response is not JSON (HTTP ${response.status})`, response.status, response.status >= 500);
    }
    if (!response.ok) {
      const error = ErrorResponseSchema.safeParse(json);
      const code = error.success ? error.data.error.code : `http_${response.status}`;
      const message = error.success ? error.data.error.message : `HTTP ${response.status}`;
      throw new IntegrationError(code, message, response.status, response.status >= 500 || response.status === 429, error.success ? error.data.error.details : undefined);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
      throw new IntegrationError('invalid_response', `The response does not follow the protocol: ${issues.join('; ')}`, response.status, false, parsed.error.issues);
    }
    return parsed.data;
  }
}
