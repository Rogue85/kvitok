import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { CreateApiTokenInput } from '@kvitok/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { client, createTestApp, createUser, createWorkspace, login, resetDb, setupWorkspace } from '../helpers';

describe('personal access tokens', () => {
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

  async function createToken(http: ReturnType<typeof client>, input: CreateApiTokenInput): Promise<string> {
    const response = await http.post('/tokens', input);
    if (response.statusCode !== 201) throw new Error(`Token creation failed: ${response.body}`);
    return response.json().secret;
  }

  /** Requests with `Authorization: Bearer` and no cookie. */
  function bearer(secret: string) {
    const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
      app.inject({ method, url: `/api${url}`, headers: { authorization: `Bearer ${secret}` }, ...(payload ? { payload } : {}) });
    return {
      get: (url: string) => call('GET', url),
      post: (url: string, payload: object = {}) => call('POST', url, payload),
      patch: (url: string, payload: object) => call('PATCH', url, payload),
      delete: (url: string) => call('DELETE', url),
    };
  }

  it('creates a token shown once and lists it without the secret', async () => {
    const { http, workspaceId } = await setupWorkspace(app);

    const created = await http.post('/tokens', { name: 'Claude Code', scopes: ['read', 'read', 'config:write'], workspaceId, expiresInDays: 30 });
    const list = await http.get('/tokens');

    expect(created.statusCode).toBe(201);
    const { secret, token } = created.json();
    expect(secret).toMatch(/^kvt_[\w-]{40,}$/);
    expect(token).toMatchObject({ name: 'Claude Code', scopes: ['read', 'config:write'], workspaceId, hint: secret.slice(-4), lastUsedAt: null });
    expect(new Date(token.expiresAt).getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);
    expect(list.json()).toEqual([token]);
    expect(list.body).not.toContain(secret);

    const stored = await app.get(PrismaService).apiToken.findUniqueOrThrow({ where: { id: token.id } });
    expect(stored.tokenHash).not.toBe(secret);
  });

  it('a token works instead of a session and records its use', async () => {
    const { http, workspaceId } = await setupWorkspace(app);
    const secret = await createToken(http, { name: 'read', scopes: ['read'] });

    const ticketList = await bearer(secret).get(`/workspaces/${workspaceId}/tickets`);
    const tokens = await http.get('/tokens');

    expect(ticketList.statusCode).toBe(200);
    expect(tokens.json()[0].lastUsedAt).not.toBeNull();
  });

  it('a revoked, expired, unknown token or one of a disabled user gives 401', async () => {
    const { http, workspaceId, user } = await setupWorkspace(app);
    const revoked = await createToken(http, { name: 'revoked', scopes: ['read'] });
    const expired = await createToken(http, { name: 'expired', scopes: ['read'] });
    const ofDisabled = await createToken(http, { name: 'disabled', scopes: ['read'] });
    const prisma = app.get(PrismaService);
    const tokens: Array<{ id: string; name: string }> = (await http.get('/tokens')).json();
    const id = (name: string) => tokens.find((t) => t.name === name)!.id;

    expect((await http.delete(`/tokens/${id('revoked')}`)).statusCode).toBe(204);
    await prisma.apiToken.update({ where: { id: id('expired') }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const url = `/workspaces/${workspaceId}/tickets`;
    const beforeDisable = await bearer(ofDisabled).get(url);
    await prisma.user.update({ where: { id: user.id }, data: { disabledAt: new Date() } });

    expect((await bearer(revoked).get(url)).statusCode).toBe(401);
    expect((await bearer(expired).get(url)).statusCode).toBe(401);
    expect((await bearer('kvt_made-up').get(url)).statusCode).toBe(401);
    expect(beforeDisable.statusCode).toBe(200);
    expect((await bearer(ofDisabled).get(url)).statusCode).toBe(401);
    expect((await http.get('/tokens')).statusCode).toBe(401);
  });

  it('a token restricted to one workspace does not see others, even for a superadmin', async () => {
    const root = await createUser(app, { superadmin: true });
    const own = await createWorkspace(app, [{ user: root, role: 'admin' }]);
    const other = await createWorkspace(app, []);
    const http = client(app, await login(app, root));
    const secret = await createToken(http, { name: 'one', scopes: ['read'], workspaceId: own });

    const list = await bearer(secret).get('/workspaces');
    const otherGet = await bearer(secret).get(`/workspaces/${other}/tickets`);
    const ownGet = await bearer(secret).get(`/workspaces/${own}/tickets`);

    expect(list.json().map((w: { id: string }) => w.id)).toEqual([own]);
    const me = await bearer(secret).get('/auth/me');
    expect(me.json().workspaces.map((w: { workspaceId: string }) => w.workspaceId)).toEqual([own]);
    expect(otherGet.statusCode).toBe(404);
    expect(ownGet.statusCode).toBe(200);
  });

  it('changing the configuration needs config:write even for an admin', async () => {
    const { http, workspaceId } = await setupWorkspace(app);
    const readOnly = bearer(await createToken(http, { name: 'read', scopes: ['read'] }));
    const writer = bearer(await createToken(http, { name: 'write', scopes: ['read', 'config:write'] }));
    const writeOnly = bearer(await createToken(http, { name: 'write only', scopes: ['config:write'] }));
    const url = `/workspaces/${workspaceId}/departments`;

    const denied = await readOnly.post(url, { key: 'loyalty', title: 'Лояльность' });
    const created = await writer.post(url, { key: 'loyalty', title: 'Лояльность' });
    const cannotRead = await writeOnly.get(url);
    const integration = await writer.post(`/workspaces/${workspaceId}/integrations`, {
      name: 'sim',
      baseUrl: 'http://localhost:1',
      secret: 'secret',
    });

    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toContain('config:write');
    expect(created.statusCode).toBe(201);
    expect(cannotRead.statusCode).toBe(403);
    expect(integration.statusCode).toBe(403);
    expect(integration.json().error.message).toContain('integrations:write');
  });

  it('a token keeps the user role: an operator token cannot change the configuration', async () => {
    const { http, workspaceId } = await setupWorkspace(app, 'operator');
    const secret = await createToken(http, { name: 'op', scopes: ['read', 'config:write'] });

    const response = await bearer(secret).post(`/workspaces/${workspaceId}/departments`, { key: 'loyalty', title: 'Лояльность' });

    expect(response.statusCode).toBe(403);
  });

  it('ticket operations and token management are closed to tokens', async () => {
    const { http, workspaceId } = await setupWorkspace(app);
    const token = bearer(await createToken(http, { name: 'all', scopes: ['read', 'config:write', 'integrations:write', 'tickets:ingest'] }));

    const reply = await token.post(`/workspaces/${workspaceId}/tickets/some-ticket/replies`, { bodyHtml: '<p>Hi</p>' });
    const newToken = await token.post('/tokens', { name: 'nested', scopes: ['read'] });
    const ownTokens = await token.get('/tokens');

    expect(reply.statusCode).toBe(403);
    expect(reply.json().error.code).toBe('forbidden');
    expect(newToken.statusCode).toBe(403);
    expect(ownTokens.statusCode).toBe(200);
  });

  it('workspaces:create is only for a superadmin and without a workspace restriction', async () => {
    const { http, workspaceId } = await setupWorkspace(app);
    const root = client(app, await login(app, await createUser(app, { superadmin: true })));

    const byUser = await http.post('/tokens', { name: 'x', scopes: ['workspaces:create'] });
    const restricted = await root.post('/tokens', { name: 'x', scopes: ['workspaces:create'], workspaceId });
    const creator = bearer(await createToken(root, { name: 'creator', scopes: ['workspaces:create'] }));
    const created = await creator.post('/workspaces', { name: 'Coffee', slug: 'coffee' });

    expect(byUser.statusCode).toBe(422);
    expect(restricted.statusCode).toBe(422);
    expect(created.statusCode).toBe(201);
  });

  it('a token cannot be restricted to a foreign workspace, and a foreign token cannot be revoked', async () => {
    const { http } = await setupWorkspace(app);
    const stranger = await setupWorkspace(app);
    const strangerToken = (await stranger.http.post('/tokens', { name: 's', scopes: ['read'] })).json().token.id;

    const foreign = await http.post('/tokens', { name: 'x', scopes: ['read'], workspaceId: stranger.workspaceId });
    const revoke = await http.delete(`/tokens/${strangerToken}`);

    expect(foreign.statusCode).toBe(404);
    expect(revoke.statusCode).toBe(404);
    expect((await stranger.http.get('/tokens')).json()).toHaveLength(1);
  });
});
