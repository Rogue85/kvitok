import { t } from '@kvitok/i18n';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthContext } from '../../src/common/request';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RealtimeController } from '../../src/realtime/realtime.controller';
import { client, createApiChannel, createTestApp, createUser, createWorkspace, ingest, login, resetDb, type TestUser } from '../helpers';

describe('users and access', () => {
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

  const anonymous = (method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url: `/api${url}`, ...(payload ? { payload } : {}) });

  function sessionCookie(response: { cookies: Array<{ name: string; value: string }> }): string {
    const cookie = response.cookies.find((c) => c.name === 'sid');
    if (!cookie) throw new Error('No session cookie');
    return `sid=${cookie.value}`;
  }

  describe('first run', () => {
    const input = { name: 'Анна', email: 'Anna@example.com', password: 'password123', workspaceName: 'Кофейня', currency: 'rub' };

    it('creates the first superadmin and workspace and signs in, then closes', async () => {
      expect((await anonymous('GET', '/setup')).json()).toEqual({ required: true });

      const response = await anonymous('POST', '/setup', input);

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        user: { email: 'anna@example.com', isSuperadmin: true },
        workspaces: [{ workspaceName: 'Кофейня', workspaceSlug: 'kofeynya', role: 'admin', isMember: true }],
      });
      const http = client(app, sessionCookie(response));
      const [workspace] = (await http.get('/workspaces')).json();
      expect(workspace).toMatchObject({ currency: 'RUB' });
      const audit = (await http.get(`/workspaces/${workspace.id}/audit`)).json();
      expect(audit[0]).toMatchObject({ entity: 'workspace', action: 'create', actor: { type: 'user', name: 'Анна' } });

      expect((await anonymous('GET', '/setup')).json()).toEqual({ required: false });
      expect((await anonymous('POST', '/setup', { ...input, email: 'other@example.com' })).statusCode).toBe(409);
    });

    it('is open while no user is a superadmin and takes a free slug', async () => {
      await createUser(app);
      await app.get(PrismaService).workspace.create({ data: { id: 'w-1', name: 'Old', slug: 'support' } });

      const response = await anonymous('POST', '/setup', { ...input, workspaceName: '!!!' });

      expect(response.statusCode).toBe(201);
      expect(response.json().workspaces[0].workspaceSlug).toBe('support-2');
    });

    it('is closed once a superadmin exists', async () => {
      await createUser(app, { superadmin: true });

      expect((await anonymous('GET', '/setup')).json()).toEqual({ required: false });
      expect((await anonymous('POST', '/setup', input)).statusCode).toBe(409);
    });
  });

  describe('administration', () => {
    let root: TestUser;
    let http: ReturnType<typeof client>;
    let workspaceId: string;

    beforeEach(async () => {
      root = await createUser(app, { superadmin: true });
      workspaceId = await createWorkspace(app, [{ user: root, role: 'admin' }]);
      http = client(app, await login(app, root));
    });

    it('is only for superadmins and only with a session', async () => {
      const admin = await createUser(app);
      await createWorkspace(app, [{ user: admin, role: 'admin' }]);
      const token = await http.post('/tokens', { name: 'mcp', scopes: ['read'], workspaceId: null });

      const asAdmin = await client(app, await login(app, admin)).get('/admin/users');
      const withToken = await app.inject({ method: 'GET', url: '/api/admin/users', headers: { authorization: `Bearer ${token.json().secret}` } });

      expect(asAdmin.statusCode).toBe(403);
      expect(withToken.statusCode).toBe(403);
      expect((await http.get('/admin/users')).statusCode).toBe(200);
    });

    it('invites a user with access, who then signs in with their own password', async () => {
      const created = await http.post('/admin/users', {
        email: 'Op@example.com',
        name: 'Оператор',
        memberships: [{ workspaceId, role: 'operator' }],
      });

      expect(created.statusCode).toBe(201);
      const { user, link } = created.json();
      expect(user).toMatchObject({ email: 'op@example.com', status: 'invited', isSuperadmin: false, lastSeenAt: null });
      expect(user.memberships).toEqual([expect.objectContaining({ workspaceId, role: 'operator' })]);
      expect(link.purpose).toBe('invite');

      expect((await anonymous('GET', `/password-links/${link.token}`)).json()).toEqual({
        email: 'op@example.com',
        name: 'Оператор',
        purpose: 'invite',
      });
      expect((await anonymous('POST', `/password-links/${link.token}`, { password: 'short' })).statusCode).toBe(422);
      expect((await anonymous('POST', `/password-links/${link.token}`, { password: 'password123' })).statusCode).toBe(200);
      expect((await anonymous('POST', `/password-links/${link.token}`, { password: 'password123' })).statusCode).toBe(404);

      // The last activity stays after signing out: sessions are deleted, the user keeps it.
      await app.get(PrismaService).session.deleteMany({ where: { userId: user.id } });
      const list = (await http.get('/admin/users')).json();
      expect(list.find((u: { id: string }) => u.id === user.id)).toMatchObject({ status: 'active', lastSeenAt: expect.any(String) });
      expect((await http.post('/admin/users', { email: 'op@example.com', name: 'Дубль' })).statusCode).toBe(409);
    });

    it('creates a user all or nothing', async () => {
      const unknownWorkspace = await http.post('/admin/users', {
        email: 'x@example.com',
        name: 'X',
        memberships: [{ workspaceId, role: 'operator' }, { workspaceId: 'missing', role: 'viewer' }],
      });
      const duplicate = await http.post('/admin/users', {
        email: 'x@example.com',
        name: 'X',
        memberships: [{ workspaceId, role: 'operator' }, { workspaceId, role: 'viewer' }],
      });

      expect(unknownWorkspace.statusCode).toBe(404);
      expect(duplicate.statusCode).toBe(422);
      expect(await app.get(PrismaService).user.count({ where: { email: 'x@example.com' } })).toBe(0);
    });

    it('a workspace admin cannot take an invitation link for a user with access they do not manage', async () => {
      const admin = await createUser(app);
      const ownWorkspace = await createWorkspace(app, [{ user: admin, role: 'admin' }]);
      const adminHttp = client(app, await login(app, admin));

      // Invited by the superadmin: a future superadmin, and a user with access to another workspace.
      const future = (await http.post('/admin/users', { email: 'root2@example.com', name: 'Root 2', isSuperadmin: true })).json().user;
      const foreign = (await http.post('/admin/users', { email: 'f@example.com', name: 'F', memberships: [{ workspaceId, role: 'viewer' }] })).json().user;
      for (const user of [future, foreign]) {
        expect((await adminHttp.post(`/workspaces/${ownWorkspace}/members`, { userId: user.id, role: 'viewer' })).statusCode).toBe(201);
        expect((await adminHttp.post(`/workspaces/${ownWorkspace}/members/${user.id}/invite-link`)).statusCode).toBe(403);
      }

      // Their own invitation stays theirs to resend.
      const invited = (await adminHttp.post(`/workspaces/${ownWorkspace}/members`, { email: 'own@example.com', name: 'Own', role: 'operator' })).json();
      expect((await adminHttp.post(`/workspaces/${ownWorkspace}/members/${invited.member.userId}/invite-link`)).statusCode).toBe(201);
      // A superadmin may resend any invitation.
      expect((await http.post(`/workspaces/${ownWorkspace}/members/${future.id}/invite-link`)).statusCode).toBe(201);
    });

    it('a reset link replaces the password and ends the sessions', async () => {
      const user = await createUser(app);
      const oldCookie = await login(app, user);

      const link = (await http.post(`/admin/users/${user.id}/password-link`)).json();
      expect(link.purpose).toBe('reset');
      await anonymous('POST', `/password-links/${link.token}`, { password: 'new-password' });

      expect((await client(app, oldCookie).get('/auth/me')).statusCode).toBe(401);
      await expect(login(app, user)).rejects.toThrow();
      await login(app, { ...user, password: 'new-password' });

      const history = (await http.get(`/admin/users/${user.id}/history`)).json();
      expect(history[0]).toMatchObject({ entity: 'user', action: 'password_link', workspaceId: null, after: { purpose: 'reset' } });
    });

    it('a disabled user cannot sign in or be assigned, and is restored by enabling', async () => {
      const operator = await createUser(app);
      await http.put(`/admin/users/${operator.id}/memberships/${workspaceId}`, { role: 'operator' });
      const operatorCookie = await login(app, operator);
      const channel = await createApiChannel(http, workspaceId);
      const ticket = (await ingest(app, channel)).json();

      const disabled = await http.patch(`/admin/users/${operator.id}`, { disabled: true });

      expect(disabled.json()).toMatchObject({ status: 'disabled' });
      expect((await client(app, operatorCookie).get('/auth/me')).statusCode).toBe(401);
      await expect(login(app, operator)).rejects.toThrow();
      const assign = await http.patch(`/workspaces/${workspaceId}/tickets/${ticket.ticket_id}`, { assigneeId: operator.id });
      expect(assign.statusCode).toBe(422);
      expect(assign.json().error.details[0].message).toBe(t('api.assigneeDisabled'));
      expect((await http.post(`/admin/users/${operator.id}/password-link`)).statusCode).toBe(409);
      expect((await http.get(`/workspaces/${workspaceId}/members/candidates`)).json()).toEqual([]);

      await http.patch(`/admin/users/${operator.id}`, { disabled: false });
      await login(app, operator);
      expect((await http.patch(`/workspaces/${workspaceId}/tickets/${ticket.ticket_id}`, { assigneeId: operator.id })).statusCode).toBe(200);
    });

    it('a disabled admin does not count as the last one and does not block the others', async () => {
      const active = await createUser(app);
      const disabled = await createUser(app);
      const ws = await createWorkspace(app, [
        { user: active, role: 'admin' },
        { user: disabled, role: 'admin' },
      ]);
      await http.patch(`/admin/users/${disabled.id}`, { disabled: true });

      // The only active admin stays.
      expect((await http.put(`/admin/users/${active.id}/memberships/${ws}`, { role: 'operator' })).statusCode).toBe(409);
      // The disabled one can be demoted and removed.
      expect((await http.put(`/admin/users/${disabled.id}/memberships/${ws}`, { role: 'viewer' })).statusCode).toBe(200);
      expect((await http.delete(`/admin/users/${disabled.id}/memberships/${ws}`)).statusCode).toBe(200);
      // A disabled user cannot be given new access.
      expect((await http.put(`/admin/users/${disabled.id}/memberships/${workspaceId}`, { role: 'viewer' })).statusCode).toBe(409);
    });

    it('closes the event stream once access is lost', async () => {
      const operator = await createUser(app);
      await http.put(`/admin/users/${operator.id}/memberships/${workspaceId}`, { role: 'operator' });
      await login(app, operator);
      const session = await app.get(PrismaService).session.findFirstOrThrow({ where: { userId: operator.id } });
      const auth: AuthContext = {
        user: { id: operator.id, email: operator.email, name: 'Operator', isSuperadmin: false },
        sessionId: session.id,
        token: null,
      };
      const realtime = app.get(RealtimeController);

      expect(await realtime.hasAccess(auth, workspaceId)).toBe(true);
      await http.delete(`/admin/users/${operator.id}/memberships/${workspaceId}`);
      expect(await realtime.hasAccess(auth, workspaceId)).toBe(false);

      await http.put(`/admin/users/${operator.id}/memberships/${workspaceId}`, { role: 'operator' });
      expect(await realtime.hasAccess(auth, workspaceId)).toBe(true);
      await http.patch(`/admin/users/${operator.id}`, { disabled: true });
      expect(await realtime.hasAccess(auth, workspaceId)).toBe(false);
    });

    it('keeps an active superadmin and does not let one disable oneself', async () => {
      expect((await http.patch(`/admin/users/${root.id}`, { disabled: true })).statusCode).toBe(409);
      expect((await http.patch(`/admin/users/${root.id}`, { isSuperadmin: false })).statusCode).toBe(409);

      const second = await createUser(app, { superadmin: true });
      expect((await http.patch(`/admin/users/${second.id}`, { disabled: true })).statusCode).toBe(200);
      // The second one is disabled, so the first is still the last active superadmin.
      expect((await http.patch(`/admin/users/${root.id}`, { isSuperadmin: false })).statusCode).toBe(409);

      await http.patch(`/admin/users/${second.id}`, { disabled: false });
      const demoted = await http.patch(`/admin/users/${root.id}`, { isSuperadmin: false, name: 'Бывший админ' });
      expect(demoted.json()).toMatchObject({ isSuperadmin: false, name: 'Бывший админ' });
    });

    it('manages access to any workspace, keeping the last workspace admin', async () => {
      const user = await createUser(app);
      const other = await createWorkspace(app, [{ user, role: 'admin' }]);

      const granted = await http.put(`/admin/users/${user.id}/memberships/${workspaceId}`, { role: 'viewer' });
      expect(granted.json().memberships.map((m: { role: string }) => m.role).sort()).toEqual(['admin', 'viewer']);

      const changed = await http.put(`/admin/users/${user.id}/memberships/${workspaceId}`, { role: 'operator' });
      expect(changed.json().memberships.find((m: { workspaceId: string }) => m.workspaceId === workspaceId).role).toBe('operator');

      expect((await http.delete(`/admin/users/${user.id}/memberships/${other}`)).statusCode).toBe(409);
      const removed = await http.delete(`/admin/users/${user.id}/memberships/${workspaceId}`);
      expect(removed.json().memberships).toEqual([expect.objectContaining({ workspaceId: other })]);

      const history = (await http.get(`/admin/users/${user.id}/history`)).json();
      expect(history.map((e: { entity: string; action: string }) => `${e.entity}:${e.action}`)).toEqual(['member:delete', 'member:update', 'member:create']);
    });

    it('shows every workspace to a superadmin, marking the ones they are not a member of', async () => {
      const someone = await createUser(app);
      const foreign = await createWorkspace(app, [{ user: someone, role: 'admin' }]);

      const me = (await http.get('/auth/me')).json();

      expect(me.workspaces).toEqual([
        expect.objectContaining({ workspaceId, role: 'admin', isMember: true }),
        expect.objectContaining({ workspaceId: foreign, role: 'admin', isMember: false }),
      ]);
    });
  });

  describe('profile', () => {
    it('changes the name and the password, ending the other sessions', async () => {
      const user = await createUser(app);
      const other = client(app, await login(app, user));
      const http = client(app, await login(app, user));

      const renamed = await http.patch('/auth/me', { name: 'Новое имя' });
      expect(renamed.json()).toMatchObject({ user: { name: 'Новое имя' } });

      const sessions = (await http.get('/auth/sessions')).json();
      expect(sessions).toHaveLength(2);
      expect(sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);

      expect((await http.post('/auth/password', { currentPassword: 'wrong', newPassword: 'new-password' })).statusCode).toBe(422);
      expect((await http.post('/auth/password', { currentPassword: user.password, newPassword: 'new-password' })).statusCode).toBe(204);

      expect((await other.get('/auth/me')).statusCode).toBe(401);
      expect((await http.get('/auth/me')).statusCode).toBe(200);
      await login(app, { ...user, password: 'new-password' });
    });

    it('signs out other sessions', async () => {
      const user = await createUser(app);
      const first = client(app, await login(app, user));
      const second = client(app, await login(app, user));
      const third = client(app, await login(app, user));

      const sessions = (await third.get('/auth/sessions')).json();
      const firstId = sessions.find((s: { current: boolean }) => !s.current).id;
      expect((await third.delete(`/auth/sessions/${firstId}`)).statusCode).toBe(204);
      expect((await third.delete('/auth/sessions')).statusCode).toBe(204);

      expect((await first.get('/auth/me')).statusCode).toBe(401);
      expect((await second.get('/auth/me')).statusCode).toBe(401);
      expect((await third.get('/auth/sessions')).json()).toHaveLength(1);
    });
  });
});
