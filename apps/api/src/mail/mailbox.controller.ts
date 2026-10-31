import { t } from '@kvitok/i18n';
import { Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ChannelsService } from '../channels/channels.service';
import { errors } from '../common/errors';
import { RequireRole, WorkspaceGuard } from '../workspaces/workspace.guard';
import { MailScheduler } from './mail-scheduler';
import { MailboxTester, type MailboxTestResult } from './mailbox-tester';

@Controller('workspaces/:workspaceId/channels/:channelId')
@UseGuards(WorkspaceGuard)
@RequireRole('admin')
export class MailboxController {
  constructor(
    private readonly channels: ChannelsService,
    private readonly tester: MailboxTester,
    private readonly scheduler: MailScheduler,
  ) {}

  @Post('test')
  @HttpCode(200)
  async test(@Param('workspaceId') workspaceId: string, @Param('channelId') channelId: string): Promise<MailboxTestResult> {
    const channel = await this.channels.get(workspaceId, channelId);
    if (channel.type !== 'email') {
      throw errors.validation([{ path: 'type', message: t('api.testOnlyForMailbox'), code: 'custom' }]);
    }
    return this.tester.test(this.channels.resolveMailbox(channel));
  }

  @Post('poll')
  @HttpCode(202)
  async poll(@Param('workspaceId') workspaceId: string, @Param('channelId') channelId: string): Promise<{ queued: true }> {
    await this.channels.get(workspaceId, channelId);
    await this.scheduler.pollNow(channelId);
    return { queued: true };
  }
}
