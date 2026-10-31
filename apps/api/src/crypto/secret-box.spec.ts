import { describe, expect, it } from 'vitest';
import { SecretBox } from './secret-box';

describe('SecretBox', () => {
  const box = new SecretBox('x'.repeat(32));

  it('encrypts and decrypts an object', () => {
    const encrypted = box.encrypt({ smtpPassword: 'p@ss' });
    expect(encrypted).not.toContain('p@ss');
    expect(box.decrypt(encrypted)).toEqual({ smtpPassword: 'p@ss' });
  });

  it('gives a different ciphertext every time', () => {
    expect(box.encrypt('same')).not.toBe(box.encrypt('same'));
  });

  it('does not decrypt with a foreign key or corrupted data', () => {
    const encrypted = box.encrypt('secret');
    expect(() => new SecretBox('y'.repeat(32)).decrypt(encrypted)).toThrow();
    expect(() => box.decrypt(encrypted.slice(0, -2) + 'AA')).toThrow();
  });
});
