import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import IORedis from 'ioredis';
import { rm } from 'node:fs/promises';
import { Client } from 'pg';
import { testEnv } from './test-env';

export default async function setup(): Promise<void> {
  const env = testEnv();
  const url = new URL(env.DATABASE_URL!);
  const database = url.pathname.slice(1);
  if (!database.endsWith('_test')) {
    throw new Error(`Refusing to reset non-test database "${database}"`);
  }

  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    // ICU locale: case-insensitive Cyrillic search works even on a cluster with the C locale.
    await client.query(
      `CREATE DATABASE "${database}" TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE 'und' LOCALE 'C'`,
    );
    // A time zone other than UTC, as on developers' machines: tests catch time shifts when writing to the database, in CI too.
    await client.query(`ALTER DATABASE "${database}" SET timezone TO 'Europe/Moscow'`);
  } finally {
    await client.end();
  }

  // Test queues live under their own prefix; clean them and the test file storage.
  const redis = new IORedis(env.REDIS_URL!);
  const keys = await redis.keys(`${env.QUEUE_PREFIX}:*`);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
  await redis.quit();
  await rm(env.STORAGE_DIR!, { recursive: true, force: true });

  execSync('pnpm exec prisma migrate deploy', {
    cwd: resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: env.DATABASE_URL },
    stdio: 'pipe',
  });
}
