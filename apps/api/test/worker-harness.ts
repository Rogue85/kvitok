import { Test } from '@nestjs/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { createTransport, type SendMailOptions, type Transporter } from 'nodemailer';
import { ChannelsModule } from '../src/channels/channels.module';
import { ConfigModule } from '../src/config/config.module';
import { IngestModule } from '../src/ingest/ingest.module';
import { ImapPoller } from '../src/mail/imap-poller';
import { SandboxOutbox } from '../src/mail/sandbox-outbox.service';
import { MailIngestService } from '../src/mail/mail-ingest.service';
import { MAILBOX_SOURCE_FACTORY, type MailboxSource, type MailboxSourceFactory } from '../src/mail/mailbox-source';
import { QueueRootModule } from '../src/queue.module';
import { CryptoModule } from '../src/crypto/crypto.module';
import { EmailSender, MAIL_TRANSPORT_FACTORY, type MailTransportFactory } from '../src/mail/email-sender';
import { DeliveryRunner } from '../src/outbound/delivery-runner';
import { WebhookSender } from '../src/outbound/webhook-sender';
import { PrismaModule } from '../src/prisma/prisma.module';
import { RealtimeModule } from '../src/realtime/realtime.module';
import { RedisModule } from '../src/redis/redis.module';
import { StorageModule } from '../src/storage/storage.module';

/** A fake IMAP mailbox: emails with UID, UIDVALIDITY and a connection counter. */
export class FakeMailbox {
  uidValidity = '1';
  messages: Array<{ uid: number; source: Buffer }> = [];
  opened = 0;

  get uidNext(): number {
    return (this.messages.at(-1)?.uid ?? 0) + 1;
  }

  add(raw: string | Buffer): number {
    const uid = this.uidNext;
    this.messages.push({ uid, source: Buffer.from(raw) });
    return uid;
  }

  factory: MailboxSourceFactory = () => {
    const box = this;
    const source: MailboxSource = {
      async open() {
        box.opened += 1;
        return { uidValidity: box.uidValidity, uidNext: box.uidNext };
      },
      async *fetchSince(lastUid: number) {
        for (const message of box.messages) {
          if (message.uid > lastUid) yield message;
        }
      },
      async close() {},
    };
    return source;
  };
}

export interface SentMail {
  options: SendMailOptions;
  raw: string;
}

/** Worker parts without BullMQ processors: the test decides when to execute a delivery. Emails accumulate in `sent`. */
export interface WorkerHarness {
  context: INestApplicationContext;
  runner: DeliveryRunner;
  mailIngest: MailIngestService;
  poller: ImapPoller;
  mailbox: FakeMailbox;
  sent: SentMail[];
  failNext: (error: Error) => void;
}

export async function createWorkerHarness(): Promise<WorkerHarness> {
  const sent: SentMail[] = [];
  const mailbox = new FakeMailbox();
  let nextError: Error | null = null;

  const factory: MailTransportFactory = () =>
    ({
      async sendMail(options: SendMailOptions) {
        if (nextError) {
          const error = nextError;
          nextError = null;
          throw error;
        }
        const info = (await createTransport({ streamTransport: true, buffer: true }).sendMail(options)) as {
          messageId: string;
          message: Buffer;
        };
        sent.push({ options, raw: info.message.toString('utf8') });
        return { messageId: info.messageId };
      },
      async verify() {
        return true;
      },
      close() {},
    }) as unknown as Transporter;

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule,
      CryptoModule,
      PrismaModule,
      RedisModule,
      QueueRootModule,
      RealtimeModule,
      StorageModule,
      ChannelsModule,
      IngestModule,
    ],
    providers: [
      { provide: MAIL_TRANSPORT_FACTORY, useValue: factory },
      { provide: MAILBOX_SOURCE_FACTORY, useValue: (...args: Parameters<MailboxSourceFactory>) => mailbox.factory(...args) },
      SandboxOutbox,
      EmailSender,
      WebhookSender,
      DeliveryRunner,
      MailIngestService,
      ImapPoller,
    ],
  }).compile();
  const context = await moduleRef.init();

  return {
    context,
    runner: context.get(DeliveryRunner),
    mailIngest: context.get(MailIngestService),
    poller: context.get(ImapPoller),
    mailbox,
    sent,
    failNext: (error) => {
      nextError = error;
    },
  };
}
