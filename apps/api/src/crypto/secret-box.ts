import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 'v1';

/**
 * Encrypts channel secrets (SMTP/IMAP passwords, webhook secrets) in the database: AES-256-GCM, key from APP_SECRET.
 * Format: v1.<iv>.<tag>.<ciphertext> in base64url.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(appSecret: string) {
    this.key = createHash('sha256').update(`secret-box:${appSecret}`).digest();
  }

  encrypt(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
  }

  decrypt<T>(payload: string): T {
    const [version, iv, tag, ciphertext] = payload.split('.');
    if (version !== VERSION || !iv || !tag || !ciphertext) {
      throw new Error('Unsupported secret payload');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as T;
  }
}
