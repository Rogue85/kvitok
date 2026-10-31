import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import { htmlToPlainText } from './html';

export type AutomatedKind = 'auto_reply' | 'bounce' | 'list';

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  size: number;
  contentId: string | null;
}

export interface ParsedInboundEmail {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: { email: string; name: string | null } | null;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  html: string | null;
  date: Date | null;
  attachments: ParsedAttachment[];
  automated: AutomatedKind | null;
  /** For a bounce: the Message-ID of our email that was not delivered. */
  bouncedMessageId: string | null;
  bounceReason: string | null;
  headers: Record<string, string>;
}

const KEPT_HEADERS = ['auto-submitted', 'precedence', 'list-id', 'x-autoreply', 'x-autorespond', 'x-mailer', 'date'];
const SERVICE_PARTS = new Set(['message/delivery-status', 'message/rfc822', 'text/rfc822-headers', 'message/rfc822-headers']);

export async function parseInboundEmail(raw: Buffer | string): Promise<ParsedInboundEmail> {
  const parsed = await simpleParser(raw, { skipImageLinks: true });
  const headers = headerMap(parsed);
  const from = parsed.from?.value[0]?.address
    ? { email: parsed.from.value[0].address.toLowerCase(), name: parsed.from.value[0].name || null }
    : null;
  const html = typeof parsed.html === 'string' ? parsed.html : null;
  const automated = classify(parsed, headers, from?.email ?? '');
  const serviceParts = parsed.attachments.filter((a) => SERVICE_PARTS.has(a.contentType));

  return {
    messageId: parsed.messageId ?? null,
    inReplyTo: firstId(parsed.inReplyTo),
    references: toArray(parsed.references).flatMap(splitIds),
    from,
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    subject: (parsed.subject ?? '').trim(),
    text: (parsed.text ?? (html ? htmlToPlainText(html) : '')).trim(),
    html,
    date: parsed.date ?? null,
    attachments: parsed.attachments
      .filter((a) => !SERVICE_PARTS.has(a.contentType))
      .map((a) => ({
        filename: a.filename ?? 'attachment',
        contentType: a.contentType,
        content: a.content,
        size: a.size,
        contentId: a.cid ?? null,
      })),
    automated,
    bouncedMessageId: automated === 'bounce' ? originalMessageId(serviceParts) : null,
    // mailparser merges message/delivery-status into the email text, so look there too.
    bounceReason: automated === 'bounce' ? bounceReason([...serviceParts, { content: Buffer.from(parsed.text ?? '') }]) : null,
    headers,
  };
}

function classify(parsed: ParsedMail, headers: Record<string, string>, from: string): AutomatedKind | null {
  const contentType = parsed.headers.get('content-type') as { value?: string; params?: Record<string, string> } | undefined;
  if (
    (contentType?.value === 'multipart/report' && contentType.params?.['report-type'] === 'delivery-status') ||
    /^(mailer-daemon|postmaster)@/i.test(from)
  ) {
    return 'bounce';
  }
  const autoSubmitted = headers['auto-submitted']?.toLowerCase();
  const precedence = headers.precedence?.toLowerCase();
  if (
    (autoSubmitted && autoSubmitted !== 'no') ||
    headers['x-autoreply'] ||
    headers['x-autorespond'] ||
    precedence === 'auto_reply' ||
    precedence === 'bulk' ||
    precedence === 'junk'
  ) {
    return 'auto_reply';
  }
  if (headers['list-id'] || precedence === 'list') {
    return 'list';
  }
  return null;
}

function headerMap(parsed: ParsedMail): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const value = parsed.headers.get(name);
    if (value === undefined) continue;
    result[name] =
      value instanceof Date ? value.toISOString() : typeof value === 'object' ? String((value as { value?: unknown }).value ?? '') : String(value);
  }
  return result;
}

function addresses(value: AddressObject | AddressObject[] | undefined): string[] {
  return toArray(value)
    .flatMap((group) => group.value)
    .map((a) => a.address?.toLowerCase())
    .filter((a): a is string => Boolean(a));
}

function toArray<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function splitIds(value: string): string[] {
  return value.match(/<[^<>\s]+>/g) ?? [];
}

function firstId(value: string | undefined): string | null {
  return value ? (splitIds(value)[0] ?? null) : null;
}

function originalMessageId(parts: Array<{ content: Buffer }>): string | null {
  for (const part of parts) {
    const match = /^Message-ID:\s*(<[^>\s]+>)/im.exec(part.content.toString('utf8'));
    if (match) {
      return match[1]!;
    }
  }
  return null;
}

function bounceReason(parts: Array<{ content: Buffer }>): string | null {
  for (const part of parts) {
    const match = /^Diagnostic-Code:\s*(.+(?:\n[ \t].+)*)/im.exec(part.content.toString('utf8'));
    if (match) {
      return match[1]!.replace(/\s+/g, ' ').trim().slice(0, 500);
    }
  }
  return null;
}
