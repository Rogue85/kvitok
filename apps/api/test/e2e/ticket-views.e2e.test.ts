import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { client, createTestApp, createUser, login, resetDb, setupWorkspace } from '../helpers';

describe('ticket views', () => {
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

  async function setup() {
    const admin = await setupWorkspace(app);
    const url = `/workspaces/${admin.workspaceId}/ticket-views`;
    const member = async (role: 'operator' | 'viewer') => {
      const user = await createUser(app);
      await admin.http.post(`/workspaces/${admin.workspaceId}/members`, { userId: user.id, role });
      return { user, http: client(app, await login(app, user)) };
    };
    return { ...admin, url, operator: await member('operator'), viewer: await member('viewer') };
  }

  it('a personal view is visible and editable by its author only', async () => {
    const { http, url, operator, viewer } = await setup();
    const query = { view: 'open', assignee: 'me', priority: 'high,urgent' };

    const created = await operator.http.post(url, { name: 'Мои срочные', query });
    const id = created.json().id as string;

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: 'Мои срочные', shared: false, query, author: { id: operator.user.id }, editable: true });
    expect((await http.get(url)).json()).toEqual([]);
    expect((await viewer.http.post(url, { name: 'Читаю', query: { view: 'all' } })).statusCode).toBe(201);
    expect((await http.patch(`${url}/${id}`, { name: 'Чужое' })).statusCode).toBe(404);
    expect((await http.delete(`${url}/${id}`)).statusCode).toBe(404);

    const renamed = await operator.http.patch(`${url}/${id}`, { name: 'Срочные', query: { view: 'all' } });
    expect(renamed.json()).toMatchObject({ name: 'Срочные', query: { view: 'all' } });
    expect((await operator.http.delete(`${url}/${id}`)).statusCode).toBe(204);
    expect((await operator.http.get(url)).json()).toEqual([]);
    expect(await prisma.auditLog.count({ where: { entity: 'ticket_view' } })).toBe(0);
  });

  it('only admins share views and change shared ones; every member sees them', async () => {
    const { http, url, operator, viewer, workspaceId } = await setup();

    expect((await operator.http.post(url, { name: 'Общая', shared: true, query: {} })).statusCode).toBe(403);
    const shared = (await http.post(url, { name: 'Эскалации', shared: true, query: { attention: 'true' } })).json();
    const own = (await operator.http.post(url, { name: 'Мои', query: { assignee: 'me' } })).json();

    expect((await viewer.http.get(url)).json()).toEqual([expect.objectContaining({ id: shared.id, editable: false })]);
    expect((await operator.http.get(url)).json().map((v: { name: string }) => v.name)).toEqual(['Эскалации', 'Мои']);
    expect((await operator.http.patch(`${url}/${shared.id}`, { name: 'Моё' })).statusCode).toBe(403);
    expect((await operator.http.delete(`${url}/${shared.id}`)).statusCode).toBe(403);
    expect((await operator.http.patch(`${url}/${own.id}`, { shared: true })).statusCode).toBe(403);

    expect((await http.delete(`${url}/${shared.id}`)).statusCode).toBe(204);
    const audit = await prisma.auditLog.findMany({ where: { workspaceId, entity: 'ticket_view' }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((a) => a.action)).toEqual(['create', 'delete']);
  });

  it('validation and a foreign workspace', async () => {
    const { http, url } = await setup();
    const view = (await http.post(url, { name: 'Мои', query: { view: 'open' } })).json();
    const other = await setupWorkspace(app);

    expect((await http.post(url, { name: ' ', query: {} })).statusCode).toBe(422);
    expect((await http.post(url, { name: 'Числа', query: { page: 2 } })).statusCode).toBe(422);
    expect((await other.http.patch(`/workspaces/${other.workspaceId}/ticket-views/${view.id}`, { name: 'x' })).statusCode).toBe(404);
  });
});
