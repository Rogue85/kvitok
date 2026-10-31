import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Job } from 'bullmq';
import { ImapPoller } from './imap-poller';
import { MAIL_QUEUE } from './mail.constants';
import { MailScheduler, type PollJobData } from './mail-scheduler';

@Processor(MAIL_QUEUE, { concurrency: 3 })
export class MailProcessor extends WorkerHost {
  constructor(private readonly poller: ImapPoller) {
    super();
  }

  process(job: Job<PollJobData>): Promise<unknown> {
    return this.poller.poll(job.data.channelId);
  }
}

/** On worker start, restores the polling schedules for all mailboxes. */
@Injectable()
export class MailSchedulesBootstrap implements OnApplicationBootstrap {
  constructor(private readonly scheduler: MailScheduler) {}

  onApplicationBootstrap(): Promise<void> {
    return this.scheduler.syncAll();
  }
}
