import { t } from '@kvitok/i18n';
import type { Message } from '../generated/prisma/client';

const TOKEN_RE = /\[#T-(\d+)\]/i;
const REPLY_PREFIX_RE = /^\s*((re|fw|fwd|ответ|отв|пересл)\s*(\[\d+\])?\s*:\s*)+/i;
const MAX_REFERENCES = 10;

/** "Re: <subject> [#T-12]" — the token in the subject helps join a reply even if the customer lost the headers. */
export function replySubject(subject: string, ticketNumber: number): string {
  const base = subject.replace(REPLY_PREFIX_RE, '').trim() || t('api.defaultSubject');
  return TOKEN_RE.test(base) ? `Re: ${base}` : `Re: ${base} [#T-${ticketNumber}]`;
}

export function ticketNumberFromSubject(subject: string | null | undefined): number | null {
  const match = subject ? TOKEN_RE.exec(subject) : null;
  return match ? Number(match[1]) : null;
}

export function outboundMessageId(ticketNumber: number, messageId: string, domain: string): string {
  return `<t${ticketNumber}.${messageId}@${domain}>`;
}

/**
 * In-Reply-To — the customer's last email (or the last email of the thread),
 * References — the Message-ID chain of the thread: the first email and the last ones, at most 10.
 */
export function threadHeaders(
  messages: Array<Pick<Message, 'rfcMessageId' | 'authorType' | 'createdAt'>>,
): { inReplyTo: string | null; references: string[] } {
  const withIds = messages
    .filter((m): m is typeof m & { rfcMessageId: string } => Boolean(m.rfcMessageId))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  if (withIds.length === 0) {
    return { inReplyTo: null, references: [] };
  }

  const lastCustomer = [...withIds].reverse().find((m) => m.authorType === 'customer');
  const inReplyTo = (lastCustomer ?? withIds[withIds.length - 1]!).rfcMessageId;
  const ids = withIds.map((m) => m.rfcMessageId);
  const references = ids.length <= MAX_REFERENCES ? ids : [ids[0]!, ...ids.slice(-(MAX_REFERENCES - 1))];
  return { inReplyTo, references };
}
