import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers';

describe('the built web interface (WEB_DIR)', () => {
  let app: NestFastifyApplication;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kvitok-web-'));
    mkdirSync(join(dir, '_nuxt'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="__nuxt"></div>');
    writeFileSync(join(dir, 'favicon.svg'), '<svg/>');
    writeFileSync(join(dir, '_nuxt', 'entry.abc123.js'), 'console.log(1)');
    process.env.WEB_DIR = dir;
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.WEB_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves files, with long caching for hashed assets only', async () => {
    const asset = await app.inject({ method: 'GET', url: '/_nuxt/entry.abc123.js' });
    const icon = await app.inject({ method: 'GET', url: '/favicon.svg' });

    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');
    expect(icon.statusCode).toBe(200);
    expect(icon.headers['cache-control']).toBe('no-cache');
  });

  it('answers client-side routes with index.html', async () => {
    for (const url of ['/', '/login', '/w/abc/tickets?status=open']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(200);
      expect(response.body, url).toContain('__nuxt');
    }
  });

  it('leaves /api to the API: an unknown route is a JSON 404', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    const unknown = await app.inject({ method: 'GET', url: '/api/nope' });

    expect(health.json()).toMatchObject({ status: 'ok' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.headers['content-type']).toContain('application/json');
  });
});
