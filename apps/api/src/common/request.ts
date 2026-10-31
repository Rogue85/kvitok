import type { ApiTokenScope, AuthUser, WorkspaceRole } from '@kvitok/shared';
import type { FastifyRequest } from 'fastify';

/** A request authenticated with a personal access token instead of a session. */
export interface TokenContext {
  id: string;
  name: string;
  scopes: ApiTokenScope[];
  /** The token works only in this workspace; null — in every workspace of the user. */
  workspaceId: string | null;
}

export interface AuthContext {
  user: AuthUser;
  sessionId: string | null;
  token: TokenContext | null;
}

export interface WorkspaceContext {
  workspaceId: string;
  role: WorkspaceRole;
}

export type AppRequest = FastifyRequest & {
  auth?: AuthContext;
  workspace?: WorkspaceContext;
};
