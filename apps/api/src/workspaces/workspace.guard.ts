import { t } from '@kvitok/i18n';
import { createParamDecorator, Injectable, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALL_DEPARTMENTS, roleSatisfies, type DepartmentScope, type WorkspaceRole } from '@kvitok/shared';
import { errors } from '../common/errors';
import type { AppRequest, AuthContext, WorkspaceContext } from '../common/request';
import { MEMBERSHIP_DEPARTMENTS, membershipScope, ticketScopeWhere } from '../departments/department-access';
import { PrismaService } from '../prisma/prisma.service';

export const REQUIRED_ROLE = 'requiredWorkspaceRole';

/** Minimum workspace role for the route. viewer by default. */
export const RequireRole = (role: WorkspaceRole) => SetMetadata(REQUIRED_ROLE, role);

/** The workspace of the route and the caller's role in it, set by WorkspaceGuard. */
export const CurrentWorkspace = createParamDecorator((_: unknown, ctx: ExecutionContext): WorkspaceContext => {
  const request = ctx.switchToHttp().getRequest<AppRequest>();
  if (request.workspace === undefined) {
    throw new Error('CurrentWorkspace used without WorkspaceGuard');
  }
  return request.workspace;
});

/**
 * Checks membership in the workspace from the `:workspaceId` parameter.
 * A foreign workspace returns 404 so as not to reveal it exists. A superadmin works as admin everywhere.
 * A `:ticketId` parameter outside the caller's departments is 404 too, like a missing ticket: this covers every
 * ticket sub-resource, and it runs before body validation.
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
    const { role, scope } = await workspaceAccess(this.prisma, auth, workspaceId);
    if (!roleSatisfies(role, required)) {
      throw errors.forbidden();
    }

    const ticketId = (request.params as Record<string, string | undefined>).ticketId;
    if (ticketId !== undefined && !scope.all) {
      const visible = await this.prisma.ticket.count({ where: { id: ticketId, workspaceId, ...ticketScopeWhere(scope) } });
      if (visible === 0) {
        throw errors.notFound(t('api.ticketNotFound'));
      }
    }

    request.workspace = { workspaceId, role, scope };
    return true;
  }
}

/** The user's role in the workspace; see `workspaceAccess`. */
export async function workspaceRole(prisma: PrismaService, auth: AuthContext, workspaceId: string): Promise<WorkspaceRole> {
  return (await workspaceAccess(prisma, auth, workspaceId)).role;
}

/**
 * The user's role in the workspace and the departments they may see: a superadmin works as admin everywhere.
 * A foreign workspace, or one outside the token's restriction, is 404 so as not to reveal it exists.
 */
export async function workspaceAccess(
  prisma: PrismaService,
  auth: AuthContext,
  workspaceId: string,
): Promise<{ role: WorkspaceRole; scope: DepartmentScope }> {
  const tokenWorkspaceId = auth.token?.workspaceId ?? null;
  const access = tokenWorkspaceId !== null && tokenWorkspaceId !== workspaceId ? null : await memberAccess(prisma, auth, workspaceId);
  if (access === null) {
    throw errors.notFound(t('api.workspaceNotFound'));
  }
  return access;
}

async function memberAccess(
  prisma: PrismaService,
  auth: AuthContext,
  workspaceId: string,
): Promise<{ role: WorkspaceRole; scope: DepartmentScope } | null> {
  if (auth.user.isSuperadmin) {
    return (await prisma.workspace.count({ where: { id: workspaceId } })) > 0 ? { role: 'admin', scope: ALL_DEPARTMENTS } : null;
  }
  const membership = await prisma.membership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: auth.user.id } },
    include: MEMBERSHIP_DEPARTMENTS,
  });
  return membership === null ? null : { role: membership.role, scope: await membershipScope(prisma, workspaceId, membership) };
}
