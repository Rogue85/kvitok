import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';

/**
 * Tests use a separate database `<name from DATABASE_URL>_test`, which globalSetup recreates on every run.
 * TEST_DATABASE_URL sets it explicitly.
 */
export function testEnv(): Record<string, string> {
  loadDotenv({ path: resolve(__dirname, '../.env'), quiet: true });

  const base = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://kvitok:kvitok@localhost:5432/kvitok';
  const url = new URL(base);
  if (!process.env.TEST_DATABASE_URL) {
    url.pathname = `${url.pathname.replace(/_test$/, '')}_test`;
  }

  return {
    NODE_ENV: 'test',
    // Assertions check English messages whatever language the developer's .env sets.
    APP_LOCALE: 'en',
    DATABASE_URL: url.toString(),
    REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
    APP_SECRET: 'test-secret-test-secret-test-secret-00',
    SESSION_TTL_DAYS: '30',
    COOKIE_SECURE: 'auto',
    WEB_ORIGIN: 'http://localhost:3000',
    LOGIN_RATE_LIMIT: '1000',
    QUEUE_PREFIX: 'test-bull',
    REPLY_UNDO_SECONDS: '10',
    STORAGE_DIR: resolve(__dirname, '../storage-test'),
  };
}
