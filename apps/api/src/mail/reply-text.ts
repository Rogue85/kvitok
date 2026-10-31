import EmailReplyParser from 'email-reply-parser';

/** Start of a quoted email in Russian and English mail clients. */
const QUOTE_HEADER_RES = [
  /^-{2,}\s*(original message|исходное сообщение|пересылаемое сообщение|forwarded message)\s*-{2,}\s*$/im,
  /^.{0,200}(?:^|\s)(пишет|написал(?:\(а\))?|написала|wrote)\s*:\s*$/im,
  /^(от|from)\s*:.*\n(отправлено|sent|дата|date)\s*:/im,
  /^_{10,}\s*$/m,
];

/**
 * Reply text without the quote and the signature — this is what the agent sees.
 * First email-reply-parser (English templates, ">" quotes, signatures), then Russian quote headers.
 */
export function extractReplyText(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n');
  let reply = new EmailReplyParser().parseReply(normalized);

  for (const re of QUOTE_HEADER_RES) {
    const match = re.exec(reply);
    if (match && match.index > 0) {
      reply = reply.slice(0, match.index);
    }
  }

  reply = reply
    .split('\n')
    .filter((line) => !line.startsWith('>'))
    .join('\n')
    .trim();

  // If the whole email turned out to be a "quote" (e.g. the customer replied inside it), return the full text.
  return reply === '' ? normalized.trim() : reply;
}
