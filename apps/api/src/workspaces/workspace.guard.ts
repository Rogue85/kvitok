import { t } from '@kvitok/i18n';
import { Injectable, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { roleSatisfies, type WorkspaceRole } from '@kvitok/shared';
import { errors } from '../common/errors';
import type { AppRequest } from '../common/request';
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
    const user = request.auth?.user;
    if (workspaceId === undefined || user === undefined) {
      throw errors.notFound();
    }

    const required =
      this.reflector.getAllAndOverride<WorkspaceRole | undefined>(REQUIRED_ROLE, [context.getHandler(), context.getClass()]) ??
      'viewer';

    let role: WorkspaceRole | null = null;
    if (user.isSuperadmin) {
      const exists = await this.prisma.workspace.count({ where: { id: workspaceId } });
      role = exists > 0 ? 'admin' : null;
    } else {
      const membership = await this.prisma.membership.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: user.id } },
      });
      role = membership?.role ?? null;
    }

    if (role === null) {
      throw errors.notFound(t('api.workspaceNotFound'));
    }
    if (!roleSatisfies(role, required)) {
      throw errors.forbidden();
    }

    request.workspace = { workspaceId, role };
    return true;
  }
}
