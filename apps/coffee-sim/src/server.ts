import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  ActionRequestSchema,
  ContextRequestSchema,
  IDEMPOTENCY_HEADER,
  protocolError,
  ResolveRequestSchema,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  ToolCallRequestSchema,
  verifySignature,
  type ExecuteResponse,
  type Manifest,
  type ProtocolErrorCode,
  type ResolveResponse,
} from '@kvitok/protocol';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { simActions, type SimAction } from './actions.js';
import { DEFAULT_SIM_LOCALE, localizer, type Localize, type SimLocale } from './locale.js';
import { buildManifest, manifestEtag } from './manifest.js';
import { loadWorld } from './scenarios.js';
import { SimStore, type Guest } from './store.js';
import { buildContext, SimError, simTools, type SimTool } from './tools.js';

export interface SimServerOptions {
  /** Shared secret for signing requests. */
  secret: string;
  /** Which scenarios to load; all by default. */
  scenarios?: string[];
  scenariosDir?: string;
  /** Language of the dataset and of every text the agent sees; `en` by default. */
  locale?: SimLocale;
  /** Service /__sim/* endpoints — reset, execution journal, failures. Unsigned, for tests and development only. */
  admin?: boolean;
  /** Prefix of the protocol paths, e.g. `/api/support`. */
  prefix?: string;
  /** How long to hold the response for a `timeout` failure. */
  faultTimeoutMs?: number;
  logger?: boolean;
}

export type FaultMode = 'timeout' | 'error_500' | 'drop_response';

interface Fault {
  /** `execute:accrue_points`, `execute:*`, `tool:get_coupons`, `resolve`, `context`, `manifest`, `*`. */
  target: string;
  mode: FaultMode;
  remaining: number;
}

export interface SimServer {
  app: FastifyInstance;
  readonly store: SimStore;
  readonly manifest: Manifest;
  readonly locale: SimLocale;
  /** Rebuild the world: all scenarios or only the given ones. */
  reset(scenarios?: string[]): void;
  addFault(target: string, mode: FaultMode, times?: number): void;
  listen(port?: number, host?: string): Promise<string>;
  close(): Promise<void>;
}

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

const FaultSchema = z.object({ target: z.string().min(1), mode: z.enum(['timeout', 'error_500', 'drop_response']), times: z.number().int().min(1).default(1) });

/** Fingerprint of an execute request: the same key with other parameters is a conflict. */
function stableHash(value: unknown): string {
  const stable = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])])) : v;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function send(reply: FastifyReply, code: ProtocolErrorCode, message: string, details?: unknown): FastifyReply {
  const error = protocolError(code, message, details);
  return reply.status(error.status).send(error.body);
}

function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown, l: Localize): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new SimError(
      'invalid_arguments',
      parsed.error.issues.map((i) => `${i.path.join('.') || l({ en: '(root)', ru: '(корень)' })}: ${i.message}`).join('; '),
      parsed.error.issues,
    );
  }
  return parsed.data;
}

export function createSimServer(options: SimServerOptions): SimServer {
  const prefix = (options.prefix ?? '').replace(/\/$/, '');
  const faultTimeoutMs = options.faultTimeoutMs ?? 30_000;
  const locale = options.locale ?? DEFAULT_SIM_LOCALE;
  const l = localizer(locale);
  const manifest = buildManifest(locale);
  const etag = manifestEtag(manifest);
  const tools = new Map<string, SimTool>(simTools(locale).map((t) => [t.name, t]));
  const actions = new Map<string, SimAction>(simActions(locale).map((a) => [a.name, a]));
  let faults: Fault[] = [];

  const build = (ids?: string[]) => {
    const world = loadWorld({ dir: options.scenariosDir, ids: ids ?? options.scenarios, locale });
    return new SimStore(world.base, world.scenarios);
  };
  let store = build();

  const app = Fastify({ logger: options.logger ?? false, forceCloseConnections: true });

  // The signature covers the body as is — keep it before parsing JSON.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    request.rawBody = body as string;
    try {
      done(null, body === '' ? {} : JSON.parse(body as string));
    } catch {
      done(new SimError('invalid_arguments', l({ en: 'The body is not JSON', ru: 'Тело — не JSON' })), undefined);
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof SimError) return send(reply, error.code, error.message, error.details);
    app.log.error(error);
    return send(reply, 'internal', error instanceof Error ? error.message : l({ en: 'Simulator error', ru: 'Ошибка симулятора' }));
  });
  app.setNotFoundHandler((_request, reply) => send(reply, 'not_found', l({ en: 'No such endpoint', ru: 'Нет такого эндпоинта' })));

  /** The failure triggered for the target; `null` — no failure. */
  const takeFault = (target: string): FaultMode | null => {
    const fault = faults.find((f) => f.remaining > 0 && (f.target === target || f.target === '*' || (f.target.endsWith(':*') && target.startsWith(f.target.slice(0, -1)))));
    if (!fault) return null;
    fault.remaining -= 1;
    faults = faults.filter((f) => f.remaining > 0);
    return fault.mode;
  };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** A failure before processing: 500 without execution. timeout and drop_response fire after processing. */
  const withFault = async (target: string, reply: FastifyReply, handle: () => unknown): Promise<unknown> => {
    const mode = takeFault(target);
    if (mode === 'error_500') return send(reply, 'internal', l({ en: 'Failure (simulated)', ru: 'Сбой (симуляция)' }));
    const result = await handle();
    if (mode === 'drop_response') return reply.status(502).type('text/html').send('<html>502 Bad Gateway</html>');
    if (mode === 'timeout') await sleep(faultTimeoutMs);
    return result;
  };

  const customer = (ref: string | null | undefined): Guest => {
    const guest = ref ? store.guests.get(ref) : undefined;
    if (!guest) throw new SimError('unknown_customer', l({ en: `Customer ${ref ?? ''} not found`, ru: `Клиент ${ref ?? ''} не найден` }));
    return guest;
  };

  app.register(
    async (api) => {
      api.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
        const verified = verifySignature({
          secret: options.secret,
          method: request.method,
          path: request.url,
          body: request.rawBody ?? '',
          timestamp: request.headers[TIMESTAMP_HEADER],
          signature: request.headers[SIGNATURE_HEADER],
        });
        if (!verified.ok) return send(reply, 'invalid_signature', l({ en: `Signature check failed: ${verified.reason}`, ru: `Подпись не прошла проверку: ${verified.reason}` }));
      });

      api.get('/manifest', async (request, reply) =>
        withFault('manifest', reply, () => {
          reply.header('etag', etag);
          if (request.headers['if-none-match'] === etag) return reply.status(304).send();
          return manifest;
        }),
      );

      api.post('/customers/resolve', async (request, reply) =>
        withFault('resolve', reply, (): ResolveResponse => {
          const { identities } = parseOrThrow(ResolveRequestSchema, request.body, l);
          // Strong identities first; the following ones only narrow the matches.
          let matches: Guest[] | null = null;
          for (const type of ['phone', 'card_number', 'email']) {
            const value = identities[type];
            if (!value) continue;
            const found = store.findGuests(type, value);
            if (found.length === 0) continue;
            if (matches === null) matches = found;
            else {
              const narrowed: Guest[] = matches.filter((g) => found.includes(g));
              if (narrowed.length > 0) matches = narrowed;
            }
          }
          if (!matches || matches.length === 0) return { status: 'not_found' };
          if (matches.length === 1) return { status: 'found', customer_ref: matches[0]!.id, display_name: matches[0]!.name };
          return {
            status: 'ambiguous',
            candidates: [...matches].sort((x, y) => x.id.localeCompare(y.id)).slice(0, 20).map((g) => ({ customer_ref: g.id, display_name: g.name, hint: l({ en: `card …${g.cardNumber.slice(-4)}, phone …${g.phone.slice(-4)}`, ru: `карта …${g.cardNumber.slice(-4)}, телефон …${g.phone.slice(-4)}` }) })),
          };
        }),
      );

      api.post('/context', async (request, reply) =>
        withFault('context', reply, () => buildContext(store, customer(parseOrThrow(ContextRequestSchema, request.body, l).customer_ref), locale)),
      );

      api.post<{ Params: { name: string } }>('/tools/:name', async (request, reply) => {
        const tool = tools.get(request.params.name);
        if (!tool) return send(reply, 'unknown_tool', l({ en: `No tool ${request.params.name}`, ru: `Нет tool ${request.params.name}` }));
        return withFault(`tool:${tool.name}`, reply, () => {
          const body = parseOrThrow(ToolCallRequestSchema, request.body, l);
          const guest = tool.requiresCustomer ? customer(body.customer_ref) : body.customer_ref ? (store.guests.get(body.customer_ref) ?? null) : null;
          return tool.run({ store, guest }, parseOrThrow(tool.input, body.args, l));
        });
      });

      api.post<{ Params: { name: string } }>('/actions/:name/validate', async (request, reply) => {
        const action = actions.get(request.params.name);
        if (!action) return send(reply, 'unknown_action', l({ en: `No action ${request.params.name}`, ru: `Нет действия ${request.params.name}` }));
        return withFault(`validate:${action.name}`, reply, () => {
          const body = parseOrThrow(ActionRequestSchema, request.body, l);
          const guest = customer(body.customer_ref);
          const outcome = action.validate({ store, guest }, parseOrThrow(action.input, body.params, l));
          return {
            ok: outcome.ok,
            normalized_params: outcome.normalized,
            ...(outcome.preview ? { preview: outcome.preview } : {}),
            warnings: outcome.warnings,
            errors: outcome.errors,
          };
        });
      });

      api.post<{ Params: { name: string } }>('/actions/:name/execute', async (request, reply) => {
        const action = actions.get(request.params.name);
        if (!action) return send(reply, 'unknown_action', l({ en: `No action ${request.params.name}`, ru: `Нет действия ${request.params.name}` }));
        const key = request.headers[IDEMPOTENCY_HEADER];
        if (typeof key !== 'string' || key.trim() === '') return send(reply, 'invalid_arguments', l({ en: 'The Idempotency-Key header is required', ru: 'Нужен заголовок Idempotency-Key' }));
        return withFault(`execute:${action.name}`, reply, () => {
          const body = parseOrThrow(ActionRequestSchema, request.body, l);
          const paramsHash = stableHash({ action: action.name, customer_ref: body.customer_ref, params: body.params });
          const previous = store.executions.get(key);
          if (previous) {
            if (previous.paramsHash !== paramsHash) throw new ConflictError();
            return previous.response;
          }
          const guest = customer(body.customer_ref);
          // execute validates the parameters again: the result of an earlier validate may be stale.
          const outcome = action.validate({ store, guest }, parseOrThrow(action.input, body.params, l));
          let response: ExecuteResponse;
          if (!outcome.ok) {
            response = { status: 'failed', error: outcome.errors.map((e) => e.message).join('; ') };
          } else {
            const { result, externalRef } = action.execute({ store, guest }, outcome.normalized);
            response = { status: 'executed', result, external_ref: externalRef };
          }
          store.executions.set(key, { key, action: action.name, customerRef: guest.id, paramsHash, params: body.params, response, at: store.now });
          return response;
        }).catch((error: unknown) => {
          if (error instanceof ConflictError) return send(
            reply,
            'idempotency_conflict',
            l({ en: 'This Idempotency-Key was already used with other parameters', ru: 'Этот Idempotency-Key уже использован с другими параметрами' }),
          );
          throw error;
        });
      });

      api.get<{ Params: { key: string } }>('/actions/executions/:key', async (request) => {
        const execution = store.executions.get(request.params.key);
        if (!execution) return { status: 'unknown' };
        return { action: execution.action, ...execution.response };
      });
    },
    { prefix },
  );

  if (options.admin ?? true) {
    app.register(
      async (admin) => {
        admin.get('/scenarios', async () => store.scenarios.map((s) => ({ id: s.id, title: s.title, tags: s.tags, expect: s.expect })));
        admin.post('/reset', async (request) => {
          const body = z.object({ scenarios: z.array(z.string()).optional() }).parse(request.body ?? {});
          store = build(body.scenarios);
          faults = [];
          return { ok: true, scenarios: store.scenarios.map((s) => s.id) };
        });
        admin.get('/executions', async () => [...store.executions.values()]);
        admin.get<{ Params: { id: string } }>('/guests/:id', async (request) => {
          const guest = customer(request.params.id);
          return { ...guest, active_cups: store.activeCups(guest.id), coupons: store.couponsOf(guest.id).length };
        });
        admin.post('/faults', async (request) => {
          const fault = FaultSchema.parse(request.body);
          faults.push({ target: fault.target, mode: fault.mode, remaining: fault.times });
          return { ok: true };
        });
        admin.delete('/faults', async () => {
          faults = [];
          return { ok: true };
        });
      },
      { prefix: `${prefix}/__sim` },
    );
  }

  return {
    app,
    get store() {
      return store;
    },
    manifest,
    locale,
    reset(ids) {
      store = build(ids);
      faults = [];
    },
    addFault(target, mode, times = 1) {
      faults.push({ target, mode, remaining: times });
    },
    async listen(port = 0, host = '127.0.0.1') {
      await app.listen({ port, host });
      const address = app.server.address() as AddressInfo;
      return `http://${host}:${address.port}${prefix}`;
    },
    close: () => app.close(),
  };
}

class ConflictError extends Error {}
