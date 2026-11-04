import { randomUUID } from 'node:crypto';
import { IntegrationClient, IntegrationError } from './client.js';
import { ErrorResponseSchema, ExecutionStatusResponseSchema, PROTOCOL_PATHS, type Manifest } from './schemas.js';
import { signatureHeaders } from './signature.js';

/**
 * Profile for checking a particular implementation.
 * The execute checks really execute the action — run them against staging with a test customer.
 */
export interface ConformanceProfile {
  baseUrl: string;
  secret: string;
  /** Identities of an existing test customer. */
  customer: { identities: Record<string, string> };
  /** Identities that certainly do not exist; by default the same types with values that cannot exist. */
  unknownIdentities?: Record<string, string>;
  /** Tool arguments; by default the first example from the manifest. */
  tools?: Record<string, Record<string, unknown>>;
  /** Action parameters; by default the first example from the manifest. */
  actions?: Record<string, Record<string, unknown>>;
  /** false — skip the execute checks (e.g. against production). */
  execute?: boolean;
  timeoutMs?: number;
}

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface ConformanceCheck {
  id: string;
  title: string;
  status: CheckStatus;
  details?: string;
}

export interface ConformanceReport {
  ok: boolean;
  checks: ConformanceCheck[];
}

class CheckFailed extends Error {}

function fail(message: string): never {
  throw new CheckFailed(message);
}

/** Runs the protocol checks against an implementation. Does not stop at the first failure. */
export async function runConformance(profile: ConformanceProfile): Promise<ConformanceReport> {
  const client = new IntegrationClient({ baseUrl: profile.baseUrl, secret: profile.secret, timeoutMs: profile.timeoutMs });
  const checks: ConformanceCheck[] = [];
  const check = async (id: string, title: string, body: () => Promise<string | void | CheckStatus>): Promise<void> => {
    try {
      const result = await body();
      checks.push(result === 'skip' ? { id, title, status: 'skip' } : { id, title, status: 'pass', ...(result && result !== 'pass' ? { details: result } : {}) });
    } catch (error) {
      const details = error instanceof CheckFailed ? error.message : error instanceof IntegrationError ? `${error.code}: ${error.message}` : String(error);
      checks.push({ id, title, status: 'fail', details });
    }
  };
  const raw = rawRequester(profile);

  let manifest: Manifest | null = null;
  await check('manifest.schema', 'the manifest matches the schema', async () => {
    const result = await client.manifest();
    if (result.notModified) fail('304 without If-None-Match');
    manifest = (result as { manifest: Manifest }).manifest;
    if (!(result as { etag: string | null }).etag) {
      return 'no ETag — the core will load the whole manifest on every sync';
    }
    const again = await client.manifest((result as { etag: string }).etag);
    if (!again.notModified) fail('304 was expected with If-None-Match for the same ETag');
  });

  await check('signature.missing', 'a request without a signature — 401', async () => {
    await expectError(await raw('GET', PROTOCOL_PATHS.manifest, undefined, { sign: false }), 401, 'invalid_signature');
  });
  await check('signature.wrong_secret', 'a foreign secret — 401', async () => {
    await expectError(await raw('GET', PROTOCOL_PATHS.manifest, undefined, { secret: `${profile.secret}-wrong` }), 401, 'invalid_signature');
  });
  await check('signature.expired', 'a signature older than 10 minutes — 401', async () => {
    await expectError(await raw('GET', PROTOCOL_PATHS.manifest, undefined, { now: new Date(Date.now() - 600_000) }), 401, 'invalid_signature');
  });
  await check('signature.other_path', 'a signature of another endpoint — 401', async () => {
    const body = { identities: profile.customer.identities };
    await expectError(await raw('POST', PROTOCOL_PATHS.resolve, body, { signPath: PROTOCOL_PATHS.context }), 401, 'invalid_signature');
  });

  let customerRef: string | null = null;
  await check('resolve.found', 'resolve finds the test customer', async () => {
    const result = await client.resolve(profile.customer.identities);
    if (result.status !== 'found') fail(`expected found, got ${result.status}`);
    customerRef = (result as { customer_ref: string }).customer_ref;
  });
  await check('resolve.matched_by', 'matched_by lists only the requested identity types', async () => {
    const result = await client.resolve(profile.customer.identities);
    if (result.status !== 'found' || result.matched_by === undefined) return 'skip';
    const extra = result.matched_by.filter((type) => !(type in profile.customer.identities));
    if (extra.length > 0) fail(`matched_by has types that were not requested: ${extra.join(', ')}`);
    if (result.matched_by.length === 0) fail('matched_by is empty for a found customer');
  });
  await check('resolve.unmatched_ignored', 'an identity that matches nobody does not hide the customer found by the others', async () => {
    const m = manifest as Manifest | null;
    const extraType = m?.identity_types.map((i) => i.type).find((type) => !(type in profile.customer.identities));
    if (!extraType) return 'skip';
    const value = extraType === 'phone' ? '70000000000' : extraType === 'email' ? `conformance-${randomUUID()}@example.invalid` : `conformance-${randomUUID()}`;
    const result = await client.resolve({ ...profile.customer.identities, [extraType]: value });
    if (result.status !== 'found') fail(`expected found with an extra unknown ${extraType}, got ${result.status}`);
    if (result.matched_by?.includes(extraType)) fail(`matched_by includes ${extraType}, which matched nobody`);
  });
  await check('resolve.not_found', 'resolve does not find a nonexistent customer', async () => {
    const identities =
      profile.unknownIdentities ??
      Object.fromEntries(Object.keys(profile.customer.identities).map((type) => [type, type === 'phone' ? '70000000000' : `conformance-${randomUUID()}`]));
    const result = await client.resolve(identities);
    if (result.status !== 'not_found') fail(`expected not_found, got ${result.status}`);
  });

  await check('context.schema', 'the customer card matches the schema', async () => {
    if (!customerRef) return 'skip';
    await client.context(customerRef);
  });
  await check('context.unknown_customer', 'the card of a nonexistent customer — 404 unknown_customer', async () => {
    await expectError(await raw('POST', PROTOCOL_PATHS.context, { customer_ref: `conformance-${randomUUID()}` }), 404, 'unknown_customer');
  });

  const m = manifest as Manifest | null;
  for (const tool of m?.tools ?? []) {
    await check(`tools.${tool.name}`, `tool ${tool.name} responds according to the schema`, async () => {
      const args = profile.tools?.[tool.name] ?? tool.examples[0]?.args;
      if (!args) return 'skip';
      if (tool.requires_customer && !customerRef) return 'skip';
      await client.callTool(tool.name, tool.requires_customer ? customerRef : null, args);
    });
  }
  await check('tools.unknown', 'an unknown tool — 404 unknown_tool', async () => {
    await expectError(await raw('POST', PROTOCOL_PATHS.tool('conformance_unknown_tool'), { customer_ref: customerRef, args: {} }), 404, 'unknown_tool');
  });
  await check('tools.invalid_arguments', 'arguments violating input_schema — 422', async () => {
    const tool = m?.tools.find((t) => Array.isArray(t.input_schema.required) && t.input_schema.required.length > 0);
    if (!tool || (tool.requires_customer && !customerRef)) return 'skip';
    await expectError(await raw('POST', PROTOCOL_PATHS.tool(tool.name), { customer_ref: tool.requires_customer ? customerRef : null, args: {} }), 422, 'invalid_arguments');
  });

  for (const set of m?.option_sets ?? []) {
    await check(`option_sets.${set.name}`, `option set ${set.name} responds according to the schema`, async () => {
      const result = await client.optionSet(set.name);
      if (result.notModified) fail('304 without If-None-Match');
      const { options, etag } = result as { options: unknown[]; etag: string | null };
      if (options.length === 0) return 'the set is empty — a field bound to it has nothing to choose from';
      if (!etag) return 'no ETag — the core will load the whole set on every sync';
      const again = await client.optionSet(set.name, etag);
      if (!again.notModified) fail('304 was expected with If-None-Match for the same ETag');
    });
  }
  await check('option_sets.unknown', 'an undeclared option set — 404 unknown_option_set', async () => {
    await expectError(await raw('GET', PROTOCOL_PATHS.optionSet('conformance_unknown_set')), 404, 'unknown_option_set');
  });

  await check('actions.unknown', 'an unknown action — 404 unknown_action', async () => {
    if (!customerRef) return 'skip';
    await expectError(await raw('POST', PROTOCOL_PATHS.validate('conformance_unknown_action'), { customer_ref: customerRef, params: {} }), 404, 'unknown_action');
  });
  await check('actions.invalid_arguments', 'parameters violating input_schema — 422', async () => {
    const action = m?.actions.find((a) => Array.isArray(a.input_schema.required) && a.input_schema.required.length > 0);
    if (!action || !customerRef) return 'skip';
    await expectError(await raw('POST', PROTOCOL_PATHS.validate(action.name), { customer_ref: customerRef, params: {} }), 422, 'invalid_arguments');
  });

  let executable: { name: string; params: Record<string, unknown> } | null = null;
  for (const action of m?.actions ?? []) {
    await check(`actions.${action.name}.validate`, `validate ${action.name} responds according to the schema`, async () => {
      const params = profile.actions?.[action.name] ?? action.examples[0]?.params;
      if (!params || !customerRef) return 'skip';
      const result = await client.validate(action.name, customerRef, params);
      if (result.ok && !executable) executable = { name: action.name, params };
      return result.ok ? undefined : `ok: false — ${result.errors.map((e) => e.message).join('; ')}`;
    });
  }

  const target = executable as { name: string; params: Record<string, unknown> } | null;
  const executeChecks: Array<[string, string, (key: string) => Promise<void>]> = [
    [
      'execute.idempotent',
      'repeating execute with the same key returns the same result',
      async (key) => {
        const first = await client.execute(target!.name, customerRef!, target!.params, key);
        const second = await client.execute(target!.name, customerRef!, target!.params, key);
        if (JSON.stringify(first) !== JSON.stringify(second)) fail('the responses to the repeat differ — the action may have been executed twice');
        const status = await client.executionStatus(key);
        if (status.status !== first.status) fail(`execution status is ${status.status}, but execute returned ${first.status}`);
      },
    ],
    [
      'execute.conflict',
      'the same key with other parameters — 409',
      async (key) => {
        await client.execute(target!.name, customerRef!, target!.params, key);
        const changed = { ...target!.params, __conformance: key };
        await expectError(
          await raw('POST', PROTOCOL_PATHS.execute(target!.name), { customer_ref: customerRef, params: changed }, { headers: { 'idempotency-key': key } }),
          409,
          'idempotency_conflict',
        );
      },
    ],
  ];
  for (const [id, title, body] of executeChecks) {
    await check(id, title, async () => {
      if (profile.execute === false || !target || !customerRef) return 'skip';
      await body(`conformance-${randomUUID()}`);
    });
  }
  await check('execution.unknown', 'status for an unknown key — unknown', async () => {
    const response = await raw('GET', PROTOCOL_PATHS.execution(`conformance-${randomUUID()}`));
    if (response.status !== 200) fail(`expected 200, got ${response.status}`);
    const parsed = ExecutionStatusResponseSchema.safeParse(response.json);
    if (!parsed.success || parsed.data.status !== 'unknown') fail(`expected status: unknown, got ${JSON.stringify(response.json)}`);
  });

  return { ok: checks.every((c) => c.status !== 'fail'), checks };
}

interface RawResponse {
  status: number;
  json: unknown;
}

/** Requests bypassing the client — to break the signature or get a raw error response. */
function rawRequester(profile: ConformanceProfile) {
  const base = new URL(profile.baseUrl.endsWith('/') ? profile.baseUrl : `${profile.baseUrl}/`);
  return async (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    options: { sign?: boolean; secret?: string; now?: Date; signPath?: string; headers?: Record<string, string> } = {},
  ): Promise<RawResponse> => {
    const url = new URL(path.replace(/^\//, ''), base);
    const payload = body === undefined ? '' : JSON.stringify(body);
    const signPath = options.signPath ? new URL(options.signPath.replace(/^\//, ''), base).pathname : url.pathname + url.search;
    const response = await fetch(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.sign === false ? {} : signatureHeaders({ secret: options.secret ?? profile.secret, method, path: signPath, body: payload, now: options.now })),
        ...options.headers,
      },
      body: body === undefined ? undefined : payload,
      signal: AbortSignal.timeout(profile.timeoutMs ?? 15_000),
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: response.status, json };
  };
}

async function expectError(response: RawResponse, status: number, code: string): Promise<void> {
  if (response.status !== status) {
    fail(`expected HTTP ${status}, got ${response.status}: ${JSON.stringify(response.json).slice(0, 300)}`);
  }
  const parsed = ErrorResponseSchema.safeParse(response.json);
  if (!parsed.success) fail(`the error body does not follow the protocol: ${JSON.stringify(response.json).slice(0, 300)}`);
  if (parsed.data.error.code !== code) fail(`expected code ${code}, got ${parsed.data.error.code}`);
}

/** Text report for the CLI and CI logs. */
export function formatConformanceReport(report: ConformanceReport): string {
  const mark: Record<CheckStatus, string> = { pass: '✓', fail: '✗', skip: '–' };
  const lines = report.checks.map((c) => `${mark[c.status]} ${c.id} — ${c.title}${c.details ? `\n    ${c.details}` : ''}`);
  const counts = (s: CheckStatus) => report.checks.filter((c) => c.status === s).length;
  lines.push('', `Total: ${counts('pass')} passed, ${counts('fail')} failed, ${counts('skip')} skipped`);
  return lines.join('\n');
}
