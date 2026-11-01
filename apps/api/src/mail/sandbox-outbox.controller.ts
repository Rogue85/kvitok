import { t } from '@kvitok/i18n';
import { Controller, Delete, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import {
  SandboxEmailListQuerySchema,
  type SandboxEmailDto,
  type SandboxEmailListDto,
  type SandboxEmailListQuery,
} from '@kvitok/shared';
import type { FastifyReply } from 'fastify';
import { emailConfig, isSandboxMailbox } from '../channels/channel-config';
import { ChannelsService } from '../channels/channels.service';
import { errors } from '../common/errors';
import type { WorkspaceContext } from '../common/request';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentWorkspace, RequireRole, WorkspaceGuard } from '../workspaces/workspace.guard';
import { SandboxOutbox } from './sandbox-outbox.service';

/** Outbox of a test mailbox: what would have been emailed and to whom. */
@Controller('workspaces/:workspaceId/channels/:channelId/outbox')
@UseGuards(WorkspaceGuard)
@RequireRole('viewer')
export class SandboxOutboxController {
  constructor(
    private readonly channels: ChannelsService,
    private readonly outbox: SandboxOutbox,
  ) {}

  @Get()
  async list(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('channelId') channelId: string,
    @Query(new ZodValidationPipe(SandboxEmailListQuerySchema)) query: SandboxEmailListQuery,
  ): Promise<SandboxEmailListDto> {
    await this.assertSandbox(workspace.workspaceId, channelId);
    return this.outbox.list(workspace, channelId, query);
  }

  @Get(':emailId')
  async get(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('channelId') channelId: string,
    @Param('emailId') emailId: string,
  ): Promise<SandboxEmailDto> {
    await this.assertSandbox(workspace.workspaceId, channelId);
    return this.outbox.get(workspace, channelId, emailId);
  }

  @Get(':emailId/raw')
  async raw(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('channelId') channelId: string,
    @Param('emailId') emailId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.assertSandbox(workspace.workspaceId, channelId);
    const email = await this.outbox.raw(workspace, channelId, emailId);
    const filename = `${email.subject.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 100) || 'letter'}.eml`;
    await reply
      .header('content-type', 'message/rfc822')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
      .header('x-content-type-options', 'nosniff')
      .send(Buffer.from(email.raw));
  }

  @Delete()
  @RequireRole('admin')
  async clear(@Param('workspaceId') workspaceId: string, @Param('channelId') channelId: string): Promise<{ deleted: number }> {
    await this.assertSandbox(workspaceId, channelId);
    return this.outbox.clear(workspaceId, channelId);
  }

  private async assertSandbox(workspaceId: string, channelId: string): Promise<void> {
    const channel = await this.channels.get(workspaceId, channelId);
    if (channel.type !== 'email' || !isSandboxMailbox(emailConfig(channel))) {
      throw errors.validation([{ path: 'channelId', message: t('api.outboxOnlyForSandbox'), code: 'custom' }]);
    }
  }
}
