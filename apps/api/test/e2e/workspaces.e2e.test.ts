import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, createUser, createWorkspace, login, resetDb, type TestUser } from '../helpers';

describe('workspaces', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await resetDb(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const request = (cookie: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url: `/api${url}`, headers: { cookie }, ...(payload ? { payload } : {}) });

  it('a user sees only their workspaces, a superadmin sees all', async () => {
    const alice = await createUser(app);
    const bob = await createUser(app);
    const root = await createUser(app, { superadmin: true });
    const aliceWs = await createWorkspace(app, [{ user: alice, role: 'viewer' }]);
    await createWorkspace(app, [{ user: bob, role: 'admin' }]);

    const aliceList = await request(await login(app, alice), 'GET', '/workspaces');
    const rootList = await request(await login(app, root), 'GET', '/workspaces');

    expect(aliceList.json().map((w: { id: string }) => w.id)).toEqual([aliceWs]);
    expect(rootList.json()).toHaveLength(2);
  });

  it('only a superadmin can create a workspace, the creator becomes admin', async () => {
    const user = await createUser(app);
    const root = await createUser(app, { superadmin: true });

    const denied = await request(await login(app, user), 'POST', '/workspaces', { name: 'X', slug: 'x-ws' });
    const rootCookie = await login(app, root);
    const created = await request(rootCookie, 'POST', '/workspaces', { name: 'Acme', slug: 'acme', currency: 'eur' });
    const duplicate = await request(rootCookie, 'POST', '/workspaces', { name: 'Acme 2', slug: 'acme' });

    expect(denied.statusCode).toBe(403);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: 'Acme', slug: 'acme', locale: 'ru', currency: 'EUR' });
    expect(duplicate.statusCode).toBe(409);

    const members = await request(rootCookie, 'GET', `/workspaces/${created.json().id}/members`);
    expect(members.json()).toEqual([expect.objectContaining({ userId: root.id, role: 'admin' })]);
  });

  it('a foreign workspace returns 404, an insufficient role — 403', async () => {
    const outsider = await createUser(app);
    const viewer = await createUser(app);
    const workspaceId = await createWorkspace(app, [{ user: viewer, role: 'viewer' }]);

    const outsiderGet = await request(await login(app, outsider), 'GET', `/workspaces/${workspaceId}`);
    const viewerCookie = await login(app, viewer);
    const viewerGet = await request(viewerCookie, 'GET', `/workspaces/${workspaceId}`);
    const viewerPatch = await request(viewerCookie, 'PATCH', `/workspaces/${workspaceId}`, { name: 'Hacked' });

    expect(outsiderGet.statusCode).toBe(404);
    expect(viewerGet.statusCode).toBe(200);
    expect(viewerPatch.statusCode).toBe(403);
  });

  it('an admin changes the workspace settings', async () => {
    const admin = await createUser(app);
    const workspaceId = await createWorkspace(app, [{ user: admin, role: 'admin' }]);

    const cookie = await login(app, admin);
    expect((await request(cookie, 'GET', `/workspaces/${workspaceId}`)).json()).toMatchObject({ currency: 'USD' });

    const response = await request(cookie, 'PATCH', `/workspaces/${workspaceId}`, {
      name: 'Новое имя',
      locale: 'en',
      currency: 'rub',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ name: 'Новое имя', locale: 'en', currency: 'RUB' });
    for (const currency of ['RUBL', 'XYZ']) {
      expect((await request(cookie, 'PATCH', `/workspaces/${workspaceId}`, { currency })).statusCode).toBe(422);
    }
  });

  describe('members', () => {
    let admin: TestUser;
    let workspaceId: string;
    let cookie: string;

    beforeEach(async () => {
      admin = await createUser(app);
      workspaceId = await createWorkspace(app, [{ user: admin, role: 'admin' }]);
      cookie = await login(app, admin);
    });

    it('gives access to an existing user and lists the others as candidates', async () => {
      const existing = await createUser(app);
      const candidates = await request(cookie, 'GET', `/workspaces/${workspaceId}/members/candidates`);
      expect(candidates.json().map((c: { id: string }) => c.id)).toEqual([existing.id]);

      const response = await request(cookie, 'POST', `/workspaces/${workspaceId}/members`, { userId: existing.id, role: 'operator' });
      const again = await request(cookie, 'POST', `/workspaces/${workspaceId}/members`, { userId: existing.id, role: 'viewer' });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ member: { userId: existing.id, role: 'operator', status: 'active' }, link: null });
      expect(again.statusCode).toBe(409);
      expect((await request(cookie, 'GET', `/workspaces/${workspaceId}/members/candidates`)).json()).toEqual([]);
    });

    it('invites a new person: the account works after the password is set by the link', async () => {
      const invited = await request(cookie, 'POST', `/workspaces/${workspaceId}/members`, {
        email: 'New@example.com',
        name: 'Новый',
        role: 'operator',
      });
      const duplicate = await request(cookie, 'POST', `/workspaces/${workspaceId}/members`, {
        email: 'new@example.com',
        name: 'Другой',
        role: 'operator',
      });

      expect(invited.statusCode).toBe(201);
      const { member, link } = invited.json();
      expect(member).toMatchObject({ email: 'new@example.com', status: 'invited' });
      expect(link).toMatchObject({ purpose: 'invite' });
      expect(duplicate.statusCode).toBe(409);
      const signIn = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'new@example.com', password: 'password123' } });
      expect(signIn.statusCode).toBe(401);

      // A new link replaces the old one.
      const reissued = await request(cookie, 'POST', `/workspaces/${workspaceId}/members/${member.userId}/invite-link`);
      expect(reissued.statusCode).toBe(201);
      expect((await app.inject({ method: 'GET', url: `/api/password-links/${link.token}` })).statusCode).toBe(404);

      const accepted = await app.inject({
        method: 'POST',
        url: `/api/password-links/${reissued.json().token}`,
        payload: { password: 'password123' },
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toMatchObject({ user: { email: 'new@example.com' }, workspaces: [{ workspaceId, role: 'operator' }] });
      await login(app, { id: member.userId, email: 'new@example.com', password: 'password123' });

      // An active member's password is reset only by a superadmin.
      const again = await request(cookie, 'POST', `/workspaces/${workspaceId}/members/${member.userId}/invite-link`);
      expect(again.statusCode).toBe(409);
    });

    it('changes the role and removes a member', async () => {
      const member = await createUser(app);
      await request(cookie, 'POST', `/workspaces/${workspaceId}/members`, { userId: member.id, role: 'viewer' });

      const promoted = await request(cookie, 'PATCH', `/workspaces/${workspaceId}/members/${member.id}`, {
        role: 'operator',
      });
      const removed = await request(cookie, 'DELETE', `/workspaces/${workspaceId}/members/${member.id}`);
      const list = await request(cookie, 'GET', `/workspaces/${workspaceId}/members`);

      expect(promoted.json()).toMatchObject({ role: 'operator' });
      expect(removed.statusCode).toBe(204);
      expect(list.json()).toHaveLength(1);
    });

    it('does not allow removing or demoting the last admin', async () => {
      const demote = await request(cookie, 'PATCH', `/workspaces/${workspaceId}/members/${admin.id}`, {
        role: 'operator',
      });
      const remove = await request(cookie, 'DELETE', `/workspaces/${workspaceId}/members/${admin.id}`);

      expect(demote.statusCode).toBe(409);
      expect(remove.statusCode).toBe(409);
    });

    it('an operator does not manage members', async () => {
      const operator = await createUser(app);
      await request(cookie, 'POST', `/workspaces/${workspaceId}/members`, { userId: operator.id, role: 'operator' });

      const operatorCookie = await login(app, operator);
      const response = await request(operatorCookie, 'POST', `/workspaces/${workspaceId}/members`, {
        email: 'x@example.com',
        name: 'X',
        role: 'admin',
      });
      const candidates = await request(operatorCookie, 'GET', `/workspaces/${workspaceId}/members/candidates`);

      expect(response.statusCode).toBe(403);
      expect(candidates.statusCode).toBe(403);
    });
  });
});
