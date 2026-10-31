import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { IngestModule } from '../ingest/ingest.module';
import { ImapPoller } from './imap-poller';
import { MailIngestService } from './mail-ingest.service';
import { MailQueueModule } from './mail-queue.module';
import { MailModule } from './mail.module';
import { MailProcessor, MailSchedulesBootstrap } from './mail.processor';

/** Receiving mail — in the worker only. */
@Module({
  imports: [MailModule, MailQueueModule, ChannelsModule, IngestModule],
  providers: [MailIngestService, ImapPoller, MailProcessor, MailSchedulesBootstrap],
  exports: [MailIngestService, ImapPoller],
})
export class MailWorkerModule {}
