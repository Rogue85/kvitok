import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MAIL_QUEUE } from './mail.constants';
import { MailScheduler } from './mail-scheduler';

/** The mail polling queue: needed by both the API (channel settings) and the worker. */
@Module({
  imports: [BullModule.registerQueue({ name: MAIL_QUEUE })],
  providers: [MailScheduler],
  exports: [MailScheduler, BullModule],
})
export class MailQueueModule {}
