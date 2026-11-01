import { t } from '@kvitok/i18n';
import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { notificationSettings, NotificationSettingsSchema, type NotificationSettings } from '@kvitok/shared';
import { CurrentAuth } from '../auth/decorators';
import { errors } from '../common/errors';
import { json } from '../common/json';
import type { AuthContext, WorkspaceContext } from '../common/request';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentWorkspace, WorkspaceGuard } from '../workspaces/workspace.guard';

/** The caller's own notification settings in the workspace; they live on the membership, so a superadmin outside it has none. */
@Controller('workspaces/:workspaceId/notification-settings')
@UseGuards(WorkspaceGuard)
export class NotificationSettingsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async get(@CurrentWorkspace() workspace: WorkspaceContext, @CurrentAuth() auth: AuthContext): Promise<NotificationSettings> {
    const membership = await this.membership(workspace.workspaceId, auth.user.id);
    return notificationSettings(membership.notificationSettings);
  }

  @Put()
  async update(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(NotificationSettingsSchema)) body: NotificationSettings,
  ): Promise<NotificationSettings> {
    await this.membership(workspace.workspaceId, auth.user.id);
    const departmentIds = body.departmentIds === null ? null : await this.existingDepartments(workspace.workspaceId, body.departmentIds);
    const settings = { ...body, departmentIds };
    await this.prisma.membership.update({
      where: { workspaceId_userId: { workspaceId: workspace.workspaceId, userId: auth.user.id } },
      data: { notificationSettings: json(settings) },
    });
    return settings;
  }

  private async membership(workspaceId: string, userId: string) {
    const membership = await this.prisma.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
    if (membership === null) throw errors.notFound(t('api.notificationsNotMember'));
    return membership;
  }

  /** Unknown ids are dropped; archived departments stay chosen, they get no new tickets anyway. */
  private async existingDepartments(workspaceId: string, ids: string[]): Promise<string[]> {
    const rows = await this.prisma.department.findMany({ where: { workspaceId, id: { in: ids } }, select: { id: true } });
    const known = new Set(rows.map((row) => row.id));
    return [...new Set(ids)].filter((id) => known.has(id));
  }
}
