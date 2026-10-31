import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import {
  CreateChannelSchema,
  UpdateChannelSchema,
  type ChannelDto,
  type ChannelSecretsDto,
  type CreateChannelInput,
  type UpdateChannelInput,
} from '@kvitok/shared';
import { RequireScope } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { MailScheduler } from '../mail/mail-scheduler';
import { RequireRole, WorkspaceGuard } from '../workspaces/workspace.guard';
import { ChannelsService } from './channels.service';

@Controller('workspaces/:workspaceId/channels')
@UseGuards(WorkspaceGuard)
@RequireScope('config:write')
@RequireRole('admin')
export class ChannelsController {
  constructor(
    private readonly channels: ChannelsService,
    private readonly mailScheduler: MailScheduler,
  ) {}

  @Get()
  @RequireRole('viewer')
  list(@Param('workspaceId') workspaceId: string): Promise<ChannelDto[]> {
    return this.channels.list(workspaceId);
  }

  @Get(':channelId')
  @RequireRole('viewer')
  get(@Param('workspaceId') workspaceId: string, @Param('channelId') channelId: string): Promise<ChannelDto> {
    return this.channels.getDto(workspaceId, channelId);
  }

  @Post()
  async create(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreateChannelSchema)) body: CreateChannelInput,
  ): Promise<ChannelSecretsDto> {
    const result = await this.channels.create(workspaceId, body);
    await this.mailScheduler.sync(result.channel.id);
    return result;
  }

  @Patch(':channelId')
  async update(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @Body(new ZodValidationPipe(UpdateChannelSchema)) body: UpdateChannelInput,
  ): Promise<ChannelSecretsDto> {
    const result = await this.channels.update(workspaceId, channelId, body);
    await this.mailScheduler.sync(channelId);
    return result;
  }

  @Post(':channelId/rotate-key')
  rotateKey(@Param('workspaceId') workspaceId: string, @Param('channelId') channelId: string): Promise<ChannelSecretsDto> {
    return this.channels.rotateApiKey(workspaceId, channelId);
  }

  @Post(':channelId/rotate-webhook-secret')
  rotateWebhookSecret(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
  ): Promise<ChannelSecretsDto> {
    return this.channels.rotateWebhookSecret(workspaceId, channelId);
  }

  @Post(':channelId/default-mailbox')
  setDefault(@Param('workspaceId') workspaceId: string, @Param('channelId') channelId: string): Promise<ChannelDto> {
    return this.channels.setDefaultMailbox(workspaceId, channelId);
  }
}
