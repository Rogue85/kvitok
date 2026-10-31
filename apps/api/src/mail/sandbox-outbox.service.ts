import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import type { SandboxEmailDto, SandboxEmailListDto, SandboxEmailListItemDto, SandboxEmailListQuery } from '@kvitok/shared';
import { simpleParser, type HeaderValue } from 'mailparser';
import { createTransport, type SendMailOptions } from 'nodemailer';
import type { ResolvedMailbox } from '../channels/channel-config';
import { errors } from '../common/errors';
import { newId } from '../common/ids';
import { json } from '../common/json';
import type { Message, Prisma, SandboxEmail } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const LIST_SELECT = {
  id: true,
  channelId: true,
  deliveryId: true,
  ticket: { select: { id: true, number: true } },
  fromAddress: true,
  fromName: true,
  to: true,
  cc: true,
  subject: true,
  attachments: true,
  size: true,
  createdAt: true,
} satisfies Prisma.SandboxEmailSelect;

type ListRow = Prisma.SandboxEmailGetPayload<{ select: typeof LIST_SELECT }>;
type Attachments = SandboxEmailDto['attachments'];

/**
 * Test mailbox: the email is built by the same nodemailer as for SMTP, but with a streaming transport
 * without network, and stored in the database. So the Outbox shows exactly what the customer would have received.
 */
@Injectable()
export class SandboxOutbox {
  constructor(private readonly prisma: PrismaService) {}

  async store(
    mailbox: ResolvedMailbox,
    message: Message,
    options: SendMailOptions,
    deliveryId: string | null,
  ): Promise<{ providerMessageId: string | null }> {
    const info = (await createTransport({ streamTransport: true, buffer: true, newline: 'windows' }).sendMail(options)) as {
      messageId?: string;
      message: Buffer;
    };
    const parsed = await simpleParser(info.message);
    const addresses = (field: typeof parsed.to): string[] =>
      (Array.isArray(field) ? field : field ? [field] : []).flatMap((a) => a.value.map((v) => v.address ?? '')).filter(Boolean);
    const from = parsed.from?.value[0];

    const data = {
      workspaceId: mailbox.channel.workspaceId,
      channelId: mailbox.channel.id,
      ticketId: message.ticketId,
      fromAddress: from?.address ?? mailbox.config.address,
      fromName: from?.name || null,
      to: addresses(parsed.to),
      cc: addresses(parsed.cc),
      subject: parsed.subject ?? '',
      rfcMessageId: parsed.messageId ?? null,
      inReplyTo: parsed.inReplyTo ?? null,
      references: typeof parsed.references === 'string' ? [parsed.references] : (parsed.references ?? []),
      html: typeof parsed.html === 'string' ? parsed.html : null,
      text: parsed.text ?? '',
      attachments: json(parsed.attachments.map((a) => ({ filename: a.filename ?? 'attachment', contentType: a.contentType, size: a.size }))),
      headers: json(
        parsed.headerLines.map((h) => ({
          key: h.key,
          value: headerText(parsed.headers.get(h.key)) ?? h.line.slice(h.line.indexOf(':') + 1).trim(),
        })),
      ),
      raw: new Uint8Array(info.message),
      size: info.message.length,
    };
    if (deliveryId) {
      // A delivery retry after a worker crash overwrites the email instead of duplicating it.
      await this.prisma.sandboxEmail.upsert({ where: { deliveryId }, create: { id: newId(), deliveryId, ...data }, update: data });
    } else {
      await this.prisma.sandboxEmail.create({ data: { id: newId(), ...data } });
    }
    return { providerMessageId: info.messageId ?? parsed.messageId ?? null };
  }

  async list(workspaceId: string, channelId: string, query: SandboxEmailListQuery): Promise<SandboxEmailListDto> {
    const where: Prisma.SandboxEmailWhereInput = {
      workspaceId,
      channelId,
      ...(query.ticketId ? { ticketId: query.ticketId } : {}),
      ...(query.address ? { id: { in: await this.idsByAddressPart(workspaceId, channelId, query.address) } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.sandboxEmail.findMany({
        where,
        select: LIST_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.sandboxEmail.count({ where }),
    ]);
    return { items: rows.map(toListItem), total, page: query.page, pageSize: query.pageSize };
  }

  async get(workspaceId: string, channelId: string, id: string): Promise<SandboxEmailDto> {
    const row = await this.prisma.sandboxEmail.findFirst({
      where: { id, workspaceId, channelId },
      select: { ...LIST_SELECT, rfcMessageId: true, inReplyTo: true, references: true, html: true, text: true, headers: true },
    });
    if (row === null) {
      throw errors.notFound(t('api.emailNotFound'));
    }
    return {
      ...toListItem(row),
      messageId: row.rfcMessageId,
      inReplyTo: row.inReplyTo,
      references: row.references,
      html: row.html,
      text: row.text,
      attachments: row.attachments as Attachments,
      headers: row.headers as SandboxEmailDto['headers'],
    };
  }

  async raw(workspaceId: string, channelId: string, id: string): Promise<Pick<SandboxEmail, 'raw' | 'subject'>> {
    const row = await this.prisma.sandboxEmail.findFirst({ where: { id, workspaceId, channelId }, select: { raw: true, subject: true } });
    if (row === null) {
      throw errors.notFound(t('api.emailNotFound'));
    }
    return row;
  }

  async clear(workspaceId: string, channelId: string): Promise<{ deleted: number }> {
    const { count } = await this.prisma.sandboxEmail.deleteMany({ where: { workspaceId, channelId } });
    return { deleted: count };
  }

  /** Search by part of an address: Prisma has no ILIKE over array elements, hence a raw query. */
  private async idsByAddressPart(workspaceId: string, channelId: string, part: string): Promise<string[]> {
    const pattern = `%${part.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM sandbox_emails
      WHERE workspace_id = ${workspaceId} AND channel_id = ${channelId}
        AND EXISTS (SELECT 1 FROM unnest("to" || cc) AS address WHERE lower(address) LIKE ${pattern})`;
    return rows.map((r) => r.id);
  }
}

/** A header value decoded by mailparser as a string; null — show it as is. */
function headerText(value: HeaderValue | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v: HeaderValue) => headerText(v) ?? '').join(', ');
  // Addresses (From, To…) have a ready text string; Content-Type and the like — value and params; List-* — as is.
  if ('text' in value && typeof value.text === 'string') return value.text;
  if ('params' in value && typeof value.value === 'string') {
    const params = Object.entries(value.params).map(([k, v]) => `; ${k}=${v}`);
    return `${value.value}${params.join('')}`;
  }
  return null;
}

function toListItem(row: ListRow): SandboxEmailListItemDto {
  return {
    id: row.id,
    channelId: row.channelId,
    ticket: row.ticket,
    deliveryId: row.deliveryId,
    from: { address: row.fromAddress, name: row.fromName },
    to: row.to,
    cc: row.cc,
    subject: row.subject,
    size: row.size,
    attachmentCount: (row.attachments as Attachments).length,
    createdAt: row.createdAt.toISOString(),
  };
}
