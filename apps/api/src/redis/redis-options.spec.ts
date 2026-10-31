import { describe, expect, it } from 'vitest';
import { redisOptionsFromUrl } from './redis-options';

describe('redisOptionsFromUrl', () => {
  it('parses the host and the default port', () => {
    expect(redisOptionsFromUrl('redis://localhost')).toEqual({ host: 'localhost', port: 6379 });
  });

  it('parses the user, password, database and TLS', () => {
    expect(redisOptionsFromUrl('rediss://user:p%40ss@redis.example.com:6380/2')).toEqual({
      host: 'redis.example.com',
      port: 6380,
      username: 'user',
      password: 'p@ss',
      db: 2,
      tls: {},
    });
  });
});
