import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { Job } from 'bullmq';
import { NotificationDispatcher } from './notification-dispatcher';
import { NOTIFY_JOB, NOTIFY_QUEUE, type NotifyJobData } from './notifications.constants';
import { NOTIFIER_CHANNELS } from './notifier-channel';
import { VapidKeysService } from './vapid-keys.service';
import { WebPushSender } from './web-push.sender';

@Processor(NOTIFY_QUEUE, { concurrency: 5 })
export class NotificationsProcessor extends WorkerHost {
  constructor(private readonly dispatcher: NotificationDispatcher) {
    super();
  }

  process(job: Job<NotifyJobData>): Promise<unknown> {
    if (job.name === NOTIFY_JOB) {
      return this.dispatcher.dispatch(job.data);
    }
    throw new Error(`Unknown notification job: ${job.name}`);
  }
}

/** Sending notifications — in the worker only. */
@Module({
  providers: [
    VapidKeysService,
    WebPushSender,
    { provide: NOTIFIER_CHANNELS, inject: [WebPushSender], useFactory: (webPush: WebPushSender) => [webPush] },
    NotificationDispatcher,
    NotificationsProcessor,
  ],
})
export class NotificationsWorkerModule {}
