import { describe, expect, it } from 'vitest';
import { loadConfig } from './env';

const base = {
  DATABASE_URL: 'postgresql://localhost/db',
  APP_SECRET: 'x'.repeat(32),
};

describe('loadConfig', () => {
  it('fills in defaults', () => {
    expect(loadConfig(base)).toMatchObject({
      nodeEnv: 'development',
      port: 3001,
      version: 'dev',
      redisUrl: 'redis://localhost:6379',
      sessionTtlDays: 30,
      cookieSecure: 'auto',
      loginRateLimit: 10,
    });
  });

  it('parses booleans and numbers from strings', () => {
    expect(loadConfig({ ...base, COOKIE_SECURE: 'true', PORT: '8080' })).toMatchObject({ cookieSecure: true, port: 8080 });
    expect(loadConfig({ ...base, COOKIE_SECURE: 'false' })).toMatchObject({ cookieSecure: false });
  });

  it('accepts only a mailto or https VAPID subject', () => {
    expect(loadConfig({ ...base, VAPID_SUBJECT: 'mailto:you@example.com' }).vapidSubject).toBe('mailto:you@example.com');
    expect(loadConfig({ ...base, VAPID_SUBJECT: 'https://support.example.com' }).vapidSubject).toBe('https://support.example.com');
    expect(loadConfig(base).vapidSubject).toBeNull();
    expect(() => loadConfig({ ...base, VAPID_SUBJECT: 'you@example.com' })).toThrow(/VAPID_SUBJECT/);
    expect(() => loadConfig({ ...base, VAPID_SUBJECT: 'mailto: you@example.com' })).toThrow(/VAPID_SUBJECT/);
  });

  it('fails with a clear error on a short secret', () => {
    expect(() => loadConfig({ ...base, APP_SECRET: 'short' })).toThrow(/APP_SECRET/);
  });
});
