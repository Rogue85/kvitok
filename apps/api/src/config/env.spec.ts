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

  it('fails with a clear error on a short secret', () => {
    expect(() => loadConfig({ ...base, APP_SECRET: 'short' })).toThrow(/APP_SECRET/);
  });
});
