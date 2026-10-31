import { t } from '@kvitok/i18n';
import { Injectable, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { roleSatisfies, type WorkspaceRole } from '@kvitok/shared';
import { errors } from '../common/errors';
import type { AppRequest, AuthContext } from '../common/request';
import { PrismaService } from '../prisma/prisma.service';

export const REQUIRED_ROLE = 'requiredWorkspaceRole';

/** Minimum workspace role for the route. viewer by default. */
export const RequireRole = (role: WorkspaceRole) => SetMetadata(REQUIRED_ROLE, role);

/**
 * Checks membership in the workspace from the `:workspaceId` parameter.
 * A foreign workspace returns 404 so as not to reveal it exists. A superadmin works as admin everywhere.
 */
@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AppRequest>();
    const workspaceId = (request.params as Record<string, string | undefined>).workspaceId;
    const auth = request.auth;
    if (workspaceId === undefined || auth === undefined) {
      throw errors.notFound();
    }

    const required =
      this.reflector.getAllAndOverride<WorkspaceRole | undefined>(REQUIRED_ROLE, [context.getHandler(), context.getClass()]) ??
      'viewer';
    const role = await workspaceRole(this.prisma, auth, workspaceId);
    if (!roleSatisfies(role, required)) {
      throw errors.forbidden();
    }

    request.workspace = { workspaceId, role };
    return true;
  }
}

/**
 * The user's role in the workspace: a superadmin works as admin everywhere.
 * A foreign workspace, or one outside the token's restriction, is 404 so as not to reveal it exists.
 */
export async function workspaceRole(prisma: PrismaService, auth: AuthContext, workspaceId: string): Promise<WorkspaceRole> {
  const tokenWorkspaceId = auth.token?.workspaceId ?? null;
  const role = tokenWorkspaceId !== null && tokenWorkspaceId !== workspaceId ? null : await memberRole(prisma, auth, workspaceId);
  if (role === null) {
    throw errors.notFound(t('api.workspaceNotFound'));
  }
  return role;
}

async function memberRole(prisma: PrismaService, auth: AuthContext, workspaceId: string): Promise<WorkspaceRole | null> {
  if (auth.user.isSuperadmin) {
    return (await prisma.workspace.count({ where: { id: workspaceId } })) > 0 ? 'admin' : null;
  }
  const membership = await prisma.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId: auth.user.id } } });
  return membership?.role ?? null;
}
