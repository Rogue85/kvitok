import { t } from '@kvitok/i18n';
import { Injectable, Logger } from '@nestjs/common';
import { emailConfig } from '../channels/channel-config';
import type { Channel } from '../generated/prisma/client';
import { InboundService, type StoredAttachment } from '../ingest/inbound.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { StorageService } from '../storage/storage.service';
import { recordEvent, SYSTEM_ACTOR } from '../tickets/ticket-events';
import { sanitizeInboundHtml } from './html';
import { parseInboundEmail, type ParsedInboundEmail } from './parse';
import { extractReplyText } from './reply-text';
import { ticketNumberFromSubject } from './threading';

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export type MailIngestResult =
  | { status: 'created' | 'appended'; ticketId: string; messageId: string }
  | { status: 'duplicate'; ticketId: string; messageId: string }
  | { status: 'bounce'; ticketId: string | null }
  | { status: 'ignored'; reason: string };

/** An email from a mailbox → a ticket: threading, auto-replies, bounces, attachments. */
@Injectable()
export class MailIngestService {
  private readonly logger = new Logger(MailIngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inbound: InboundService,
    private readonly storage: StorageService,
    private readonly realtime: RealtimeService,
  ) {}

  async ingest(channel: Channel, raw: Buffer | string): Promise<MailIngestResult> {
    const mail = await parseInboundEmail(raw);
    const mailboxAddress = emailConfig(channel).address.toLowerCase();

    if (mail.from === null) {
      return { status: 'ignored', reason: 'no sender' };
    }
    if (mail.from.email === mailboxAddress) {
      return { status: 'ignored', reason: 'own message' };
    }
    if (mail.automated === 'bounce') {
      return this.handleBounce(channel, mail);
    }

    const ticketId = await this.findThread(channel.workspaceId, mail);
    if (mail.automated !== null && ticketId === null) {
      // An auto-reply or a mailing outside a thread must not create tickets.
      return { status: 'ignored', reason: `automated (${mail.automated}) without thread` };
    }

    const attachments = await this.storeAttachments(channel.workspaceId, mail);
    const participants = [
      { email: mail.from.email, name: mail.from.name, role: 'customer' as const },
      ...[...mail.to, ...mail.cc]
        .filter((email) => email !== mailboxAddress && email !== mail.from!.email)
        .map((email) => ({ email, role: 'cc' as const })),
    ];

    const result = await this.inbound.receive({
      channel,
      source: 'email',
      ticketId: ticketId ?? undefined,
      customer: { name: mail.from.name, identities: { email: mail.from.email } },
      subject: mail.subject,
      bodyText: mail.text || t('api.emptyEmail'),
      bodyHtml: mail.html ? sanitizeInboundHtml(mail.html) : null,
      bodyClean: mail.text ? extractReplyText(mail.text) : null,
      rfcMessageId: mail.messageId,
      inReplyTo: mail.inReplyTo,
      references: mail.references,
      fromEmail: mail.from.email,
      fromName: mail.from.name,
      replyTo: mail.replyTo,
      senderAuthenticated: mail.senderAuthenticated,
      allHeaders: mail.allHeaders,
      to: mail.to,
      cc: mail.cc,
      headers: mail.headers,
      isAutomated: mail.automated !== null,
      participants,
      attachments,
    });

    if (result.duplicate) {
      return { status: 'duplicate', ticketId: result.ticketId, messageId: result.messageId };
    }
    return { status: result.ticketCreated ? 'created' : 'appended', ticketId: result.ticketId, messageId: result.messageId };
  }

  /** First by In-Reply-To/References, then by the [#T-n] token in the subject if the sender is a ticket participant. */
  private async findThread(workspaceId: string, mail: ParsedInboundEmail): Promise<string | null> {
    const ids = [...new Set([mail.inReplyTo, ...mail.references].filter((id): id is string => Boolean(id)))];
    if (ids.length > 0) {
      const message = await this.prisma.message.findFirst({
        where: { workspaceId, rfcMessageId: { in: ids } },
        orderBy: { createdAt: 'desc' },
      });
      if (message) {
        return message.ticketId;
      }
    }

    const number = ticketNumberFromSubject(mail.subject);
    if (number !== null && mail.from) {
      const ticket = await this.prisma.ticket.findFirst({
        where: {
          workspaceId,
          number,
          OR: [
            { participants: { some: { email: mail.from.email } } },
            { customer: { identities: { some: { type: 'email', value: mail.from.email } } } },
          ],
        },
      });
      if (ticket) {
        return ticket.id;
      }
    }
    return null;
  }

  private async handleBounce(channel: Channel, mail: ParsedInboundEmail): Promise<MailIngestResult> {
    const original = mail.bouncedMessageId
      ? await this.prisma.message.findFirst({
          where: { workspaceId: channel.workspaceId, rfcMessageId: mail.bouncedMessageId, authorType: 'operator' },
        })
      : null;
    if (original === null) {
      this.logger.warn(`Bounce for unknown message ${mail.bouncedMessageId ?? '(no id)'} in channel ${channel.id}`);
      return { status: 'bounce', ticketId: null };
    }

    const reason = mail.bounceReason ?? t('api.emailNotDelivered');
    await this.prisma.$transaction(async (tx) => {
      await tx.delivery.updateMany({
        where: { messageId: original.id, kind: 'email' },
        data: { status: 'failed', lastError: `Bounced: ${reason}`.slice(0, 1000) },
      });
      await recordEvent(tx, {
        workspaceId: channel.workspaceId,
        ticketId: original.ticketId,
        type: 'delivery_bounced',
        actor: SYSTEM_ACTOR,
        data: { messageId: original.id, reason },
      });
    });
    await this.realtime.publish(channel.workspaceId, { type: 'ticket.updated', ticketId: original.ticketId });
    return { status: 'bounce', ticketId: original.ticketId };
  }

  private async storeAttachments(workspaceId: string, mail: ParsedInboundEmail): Promise<StoredAttachment[]> {
    const stored: StoredAttachment[] = [];
    for (const attachment of mail.attachments) {
      if (attachment.size > MAX_ATTACHMENT_BYTES) {
        this.logger.warn(`Skipping attachment ${attachment.filename}: ${attachment.size} bytes`);
        continue;
      }
      stored.push({
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.size,
        storageKey: await this.storage.put(workspaceId, attachment.filename, attachment.content),
        contentId: attachment.contentId,
      });
    }
    return stored;
  }
}
