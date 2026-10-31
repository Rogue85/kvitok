import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { EmailSender, MAIL_TRANSPORT_FACTORY, smtpTransportFactory } from './email-sender';
import { MailboxController } from './mailbox.controller';
import { imapSourceFactory, MAILBOX_SOURCE_FACTORY } from './mailbox-source';
import { MailboxTester } from './mailbox-tester';
import { MailQueueModule } from './mail-queue.module';
import { SandboxOutboxController } from './sandbox-outbox.controller';
import { SandboxOutbox } from './sandbox-outbox.service';

/** Mail transports (SMTP, IMAP, test mailbox) and mailbox checks from the UI. Used by the API and the worker. */
@Module({
  imports: [ChannelsModule, MailQueueModule],
  controllers: [MailboxController, SandboxOutboxController],
  providers: [
    { provide: MAIL_TRANSPORT_FACTORY, useValue: smtpTransportFactory },
    { provide: MAILBOX_SOURCE_FACTORY, useValue: imapSourceFactory },
    SandboxOutbox,
    EmailSender,
    MailboxTester,
  ],
  exports: [EmailSender, MailboxTester, MAIL_TRANSPORT_FACTORY, MAILBOX_SOURCE_FACTORY],
})
export class MailModule {}
