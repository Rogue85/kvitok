import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthContext } from '../common/request';

/** Who makes a change: a user in the UI, a user through a token (MCP, API) or the system (worker, sync). */
export type AuditActor =
  | { type: 'user'; userId: string; name: string }
  | { type: 'token'; userId: string; name: string; tokenId: string; tokenName: string }
  | { type: 'system' };

const storage = new AsyncLocalStorage<AuditActor>();

export function runAs<T>(actor: AuditActor, fn: () => T): T {
  return storage.run(actor, fn);
}

/** Outside a request (worker, CLI) changes are made by the system. */
export function currentActor(): AuditActor {
  return storage.getStore() ?? { type: 'system' };
}

export function actorOf(auth: AuthContext): AuditActor {
  return auth.token === null
    ? { type: 'user', userId: auth.user.id, name: auth.user.name }
    : { type: 'token', userId: auth.user.id, name: auth.user.name, tokenId: auth.token.id, tokenName: auth.token.name };
}
