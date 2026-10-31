import { createHash, randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'sid';

/** The token goes only into the cookie; the database stores its sha256. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
