/**
 * The receiving server's verdict on the sender from `Authentication-Results`: DMARC passed, or DKIM passed with a signing
 * domain aligned to the `From` domain. null — the header is missing, the server said nothing.
 * Only the topmost header counts: it is added by our receiving server, the ones below may come from the sender.
 */
export function senderAuthenticated(header: string | null, fromEmail: string): boolean | null {
  if (!header) return null;
  const text = header.toLowerCase();
  if (/\bdmarc\s*=\s*pass\b/.test(text)) return true;
  const domain = fromEmail.split('@')[1]?.toLowerCase() ?? '';
  for (const result of text.split(';')) {
    if (!/\bdkim\s*=\s*pass\b/.test(result)) continue;
    const signer = /\bheader\.(?:d|i)\s*=\s*@?([a-z0-9.-]+)/.exec(result)?.[1];
    if (signer && (domain === signer || domain.endsWith(`.${signer}`))) return true;
  }
  return false;
}
