import type { RedisOptions } from 'ioredis';

/** BullMQ and ioredis take options, not a URL: parse redis://user:pass@host:port/db. */
export function redisOptionsFromUrl(url: string): RedisOptions {
  const parsed = new URL(url);
  const db = parsed.pathname.replace('/', '');

  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    ...(db ? { db: Number(db) } : {}),
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}
