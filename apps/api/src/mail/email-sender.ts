import { Inject, Injectable } from '@nestjs/common';
import { createTransport, type SendMailOptions, type Transporter } from 'nodemailer';
import { isSandboxMailbox, type ResolvedMailbox } from '../channels/channel-config';
import type { Attachment, Message } from '../generated/prisma/client';
import { StorageService } from '../storage/storage.service';
import { SandboxOutbox } from './sandbox-outbox.service';

export const MAIL_TRANSPORT_FACTORY = Symbol('MAIL_TRANSPORT_FACTORY');

export type MailTransportFactory = (mailbox: ResolvedMailbox) => Transporter;

export const smtpTransportFactory: MailTransportFactory = (mailbox) => {
  const smtp = mailbox.config.smtp;
  if (smtp === null) {
    throw new Error(`Mailbox ${mailbox.channel.id} has no SMTP settings`);
  }
  return createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: smtp.user, pass: mailbox.secrets.smtpPassword },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
};

export function buildMailOptions(
  mailbox: ResolvedMailbox,
  message: Message,
  attachments: Array<{ attachment: Attachment; content: Buffer }> = [],
): SendMailOptions {
  return {
    from: { name: message.fromName || mailbox.config.displayName || mailbox.config.address, address: mailbox.config.address },
    to: message.to,
    cc: message.cc.length > 0 ? message.cc : undefined,
    replyTo: mailbox.config.address,
    subject: message.subject ?? undefined,
    messageId: message.rfcMessageId ?? undefined,
    inReplyTo: message.inReplyTo ?? undefined,
    references: message.references.length > 0 ? message.references : undefined,
    html: message.bodyHtml ?? undefined,
    text: message.bodyText,
    attachments: attachments.map(({ attachment, content }) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      content,
      ...(attachment.contentId ? { cid: attachment.contentId } : {}),
    })),
  };
}

@Injectable()
export class EmailSender {
  constructor(
    @Inject(MAIL_TRANSPORT_FACTORY) private readonly transportFactory: MailTransportFactory,
    private readonly storage: StorageService,
    private readonly sandbox: SandboxOutbox,
  ) {}

  async send(
    mailbox: ResolvedMailbox,
    message: Message & { attachments: Attachment[] },
    deliveryId: string | null = null,
  ): Promise<{ providerMessageId: string | null }> {
    const attachments = await Promise.all(
      message.attachments.map(async (attachment) => ({ attachment, content: await this.storage.get(attachment.storageKey) })),
    );
    const options = buildMailOptions(mailbox, message, attachments);
    // A test mailbox is decided by the channel config, before the transport: such an email never reaches the network.
    if (isSandboxMailbox(mailbox.config)) {
      return this.sandbox.store(mailbox, message, options, deliveryId);
    }
    const transport = this.transportFactory(mailbox);
    try {
      const info = (await transport.sendMail(options)) as { messageId?: string };
      return { providerMessageId: info.messageId ?? null };
    } finally {
      transport.close();
    }
  }

  /** Checks the SMTP settings from the UI. */
  async verify(mailbox: ResolvedMailbox): Promise<void> {
    if (isSandboxMailbox(mailbox.config)) {
      return;
    }
    const transport = this.transportFactory(mailbox);
    try {
      await transport.verify();
    } finally {
      transport.close();
    }
  }
}
