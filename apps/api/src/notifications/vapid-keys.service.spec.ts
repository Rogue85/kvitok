import { describe, expect, it } from 'vitest';
import { vapidSubject } from './vapid-keys.service';

describe('vapidSubject', () => {
  it('takes WEB_ORIGIN on a public https domain', () => {
    expect(vapidSubject('https://support.example.com/', 'admin@example.com')).toBe('https://support.example.com');
  });

  it('falls back to the email when the origin is local or plain http', () => {
    expect(vapidSubject('http://localhost:3000', 'admin@example.com')).toBe('mailto:admin@example.com');
    expect(vapidSubject('https://kvitok.localhost', 'admin@example.com')).toBe('mailto:admin@example.com');
    expect(vapidSubject('https://192.168.1.10', 'admin@example.com')).toBe('mailto:admin@example.com');
  });

  it('finds nothing when the email is local too', () => {
    expect(vapidSubject('http://localhost:3000', 'admin@localhost')).toBeNull();
    expect(vapidSubject('http://localhost:3000', 'admin@kvitok.local')).toBeNull();
    expect(vapidSubject('http://localhost:3000', null)).toBeNull();
  });
});
