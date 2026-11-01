import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashSessionToken } from '../../src/auth/session-token';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp, createUser, createWorkspace, login, resetDb } from '../helpers';

describe('auth', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await resetDb(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('login sets an httpOnly cookie and returns the user with their workspaces', async () => {
    const user = await createUser(app, { email: 'Op@Example.com' });
    const workspaceId = await createWorkspace(app, [{ user, role: 'operator' }]);

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'OP@example.com', password: user.password },
    });

    expect(response.statusCode).toBe(200);
    const cookie = response.cookies.find((c) => c.name === 'sid');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');
    expect(response.json()).toMatchObject({
      user: { email: 'op@example.com', isSuperadmin: false },
      workspaces: [{ workspaceId, role: 'operator', isMember: true }],
    });

    const session = await prisma.session.findFirstOrThrow();
    expect(session.tokenHash).toBe(hashSessionToken(cookie!.value));
  });

  it('the cookie is Secure when the request came over HTTPS, directly or through a proxy', async () => {
    const user = await createUser(app);
    const payload = { email: user.email, password: user.password };

    const plain = await app.inject({ method: 'POST', url: '/api/auth/login', payload });
    const proxied = await app.inject({ method: 'POST', url: '/api/auth/login', payload, headers: { 'x-forwarded-proto': 'https' } });

    expect(plain.cookies.find((c) => c.name === 'sid')?.secure).toBeUndefined();
    expect(proxied.cookies.find((c) => c.name === 'sid')?.secure).toBe(true);
  });

  it('a wrong password and a nonexistent email give the same 401', async () => {
    const user = await createUser(app);

    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: user.email, password: 'wrong-password' },
    });
    const unknownEmail = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@example.com', password: 'wrong-password' },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(unknownEmail.json());
    expect(wrongPassword.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('an invalid body gives 422 with details', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'nope' } });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: 'validation_failed', details: expect.arrayContaining([expect.objectContaining({ path: 'email' })]) },
    });
  });

  it('a disabled user cannot sign in', async () => {
    const user = await createUser(app);
    await prisma.user.update({ where: { id: user.id }, data: { disabledAt: new Date() } });

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: user.email, password: user.password },
    });

    expect(response.statusCode).toBe(401);
  });

  it('protected routes return 401 without a cookie', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/me' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('me returns the current user', async () => {
    const user = await createUser(app);
    const cookie = await login(app, user);

    const response = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ user: { id: user.id, email: user.email }, workspaces: [] });
  });

  it('logout deletes the session', async () => {
    const user = await createUser(app);
    const cookie = await login(app, user);

    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });

    expect(logout.statusCode).toBe(204);
    expect(me.statusCode).toBe(401);
    expect(await prisma.session.count()).toBe(0);
  });

  it('an expired session does not work and gets deleted', async () => {
    const user = await createUser(app);
    const cookie = await login(app, user);
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const response = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });

    expect(response.statusCode).toBe(401);
    expect(await prisma.session.count()).toBe(0);
  });

  it('a session not used for a long time is extended', async () => {
    const user = await createUser(app);
    const cookie = await login(app, user);
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const soon = new Date(Date.now() + 60 * 1000);
    await prisma.session.updateMany({ data: { lastSeenAt: stale, expiresAt: soon } });

    await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });

    const session = await prisma.session.findFirstOrThrow();
    expect(session.lastSeenAt.getTime()).toBeGreaterThan(stale.getTime());
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);
  });
});

describe('auth rate limit', () => {
  let app: NestFastifyApplication;
  const previous = process.env.LOGIN_RATE_LIMIT;

  beforeAll(async () => {
    process.env.LOGIN_RATE_LIMIT = '3';
    app = await createTestApp();
  });

  afterAll(async () => {
    process.env.LOGIN_RATE_LIMIT = previous;
    await app.close();
  });

  it('returns 429 after the sign-in attempt limit', async () => {
    const attempt = () =>
      app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'x@example.com', password: 'nope' } });

    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push((await attempt()).statusCode);
    }

    expect(statuses).toEqual([401, 401, 401, 429]);
    expect((await attempt()).json()).toMatchObject({ error: { code: 'too_many_requests' } });
  });
});
