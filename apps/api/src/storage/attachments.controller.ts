import { t } from '@kvitok/i18n';
import { Controller, Get, Param, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { errors } from '../common/errors';
import type { WorkspaceContext } from '../common/request';
import { ticketScopeWhere } from '../departments/department-access';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentWorkspace, WorkspaceGuard } from '../workspaces/workspace.guard';
import { StorageService } from './storage.service';

@Controller('workspaces/:workspaceId/attachments')
@UseGuards(WorkspaceGuard)
export class AttachmentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  @Get(':attachmentId')
  async download(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('attachmentId') attachmentId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // A file of a ticket the caller may see; one without a message only for those who see every department.
    const attachment = await this.prisma.attachment.findFirst({
      where: {
        id: attachmentId,
        workspaceId: workspace.workspaceId,
        ...(workspace.scope.all ? {} : { message: { is: { ticket: ticketScopeWhere(workspace.scope) } } }),
      },
    });
    if (attachment === null) {
      throw errors.notFound(t('api.attachmentNotFound'));
    }
    await reply
      .header('content-type', attachment.contentType)
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`)
      .header('x-content-type-options', 'nosniff')
      .send(this.storage.stream(attachment.storageKey));
  }
}
