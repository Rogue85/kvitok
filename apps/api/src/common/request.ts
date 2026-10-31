import type { AuthUser, WorkspaceRole } from '@kvitok/shared';
import type { FastifyRequest } from 'fastify';

export interface AuthContext {
  user: AuthUser;
  sessionId: string;
}

export interface WorkspaceContext {
  workspaceId: string;
  role: WorkspaceRole;
}

export type AppRequest = FastifyRequest & {
  auth?: AuthContext;
  workspace?: WorkspaceContext;
};
