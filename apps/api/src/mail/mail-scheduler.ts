import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { emailConfig } from '../channels/channel-config';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { MAIL_QUEUE, POLL_JOB, pollSchedulerId } from './mail.constants';

export interface PollJobData {
  channelId: string;
}

/** Keeps one repeating IMAP polling job per enabled mailbox. */
@Injectable()
export class MailScheduler {
  constructor(
    @InjectQueue(MAIL_QUEUE) private readonly queue: Queue<PollJobData>,
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async sync(channelId: string): Promise<void> {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    const shouldPoll = channel !== null && channel.type === 'email' && channel.enabled && emailConfig(channel).imap !== null;

    if (!shouldPoll) {
      await this.queue.removeJobScheduler(pollSchedulerId(channelId));
      return;
    }
    await this.queue.upsertJobScheduler(
      pollSchedulerId(channelId),
      { every: this.config.mailPollSeconds * 1000 },
      { name: POLL_JOB, data: { channelId }, opts: { removeOnComplete: 50, removeOnFail: 50 } },
    );
  }

  async syncAll(): Promise<void> {
    const channels = await this.prisma.channel.findMany({ where: { type: 'email' }, select: { id: true } });
    for (const channel of channels) {
      await this.sync(channel.id);
    }
  }

  /** Poll now (the "Check mail" button). */
  async pollNow(channelId: string): Promise<void> {
    await this.queue.add(POLL_JOB, { channelId }, { removeOnComplete: 50, removeOnFail: 50 });
  }
}
