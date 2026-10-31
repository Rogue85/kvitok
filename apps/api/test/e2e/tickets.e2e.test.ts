import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OUTBOUND_QUEUE } from '../../src/outbound/outbound.constants';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  client,
  createApiChannel,
  createTestApp,
  createUser,
  ingest,
  login,
  resetDb,
  setupWorkspace,
} from '../helpers';

describe('tickets', () => {
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
    const ctx = await setupWorkspace(app);
    const channel = await createApiChannel(ctx.http, ctx.workspaceId, { webhookUrl: 'https://example.com/hook' });
    const url = `/workspaces/${ctx.workspaceId}/tickets`;
    return { ...ctx, channel, url };
  }

  it('list: filters by status, assignee, search and fields', async () => {
    const { workspaceId, http, user, channel, url } = await setup();
    await http.post(`/workspaces/${workspaceId}/fields`, { entity: 'ticket', key: 'dept_number', label: 'Отдел', type: 'number' });
    const a = (await ingest(app, channel, { subject: 'Принтер', fields: { dept_number: 214 } })).json();
    const b = (await ingest(app, channel, { subject: 'Ноутбук', customer: { identities: { email: 'petr@corp.ru' } } })).json();
    await http.patch(`${url}/${a.ticket_id}`, { assigneeId: user.id, status: 'pending' });

    const ids = async (query: string) => (await http.get(`${url}?${query}`)).json().items.map((t: { id: string }) => t.id);

    expect(await ids('')).toEqual([b.ticket_id, a.ticket_id]);
    expect(await ids('status=pending')).toEqual([a.ticket_id]);
    expect(await ids('status=new,open')).toEqual([b.ticket_id]);
    expect(await ids('assignee=me')).toEqual([a.ticket_id]);
    expect(await ids('assignee=none')).toEqual([b.ticket_id]);
    expect(await ids('q=ноутб')).toEqual([b.ticket_id]);
    expect(await ids(`q=%23T-${a.ticket_number}`)).toEqual([a.ticket_id]);
    expect(await ids('q=petr@corp')).toEqual([b.ticket_id]);
    expect(await ids('field.dept_number=214')).toEqual([a.ticket_id]);
    expect((await http.get(`${url}?field.nope=1`)).statusCode).toBe(422);
  });

  it('card and timeline', async () => {
    const { http, channel, url } = await setup();
    const created = (await ingest(app, channel)).json();
    await http.patch(`${url}/${created.ticket_id}`, { priority: 'high', tags: ['VIP', 'bonus'] });

    const detail = (await http.get(`${url}/${created.ticket_id}`)).json();
    const timeline = (await http.get(`${url}/${created.ticket_id}/timeline`)).json();

    expect(detail).toMatchObject({
      number: created.ticket_number,
      priority: 'high',
      tags: ['vip', 'bonus'],
      customer: { name: 'Иван', identities: [{ type: 'email', value: 'ivan@example.com' }] },
      participants: [{ email: 'ivan@example.com', role: 'customer' }],
      replyOptions: { email: null, source: true },
    });
    expect(timeline.map((i: { kind: string; event?: { type: string } }) => i.event?.type ?? i.kind)).toEqual([
      'ticket_created',
      'message',
      'priority_changed',
      'tags_changed',
    ]);
  });

  it('changing the department pins it and increments revision; an archived department — 422', async () => {
    const { workspaceId, http, channel, url } = await setup();
    const it = (await http.post(`/workspaces/${workspaceId}/departments`, { key: 'it', title: 'ИТ' })).json();
    const old = (await http.post(`/workspaces/${workspaceId}/departments`, { key: 'old', title: 'Старый' })).json();
    await http.patch(`/workspaces/${workspaceId}/departments/${old.id}`, { archived: true });
    const ticket = (await ingest(app, channel)).json();

    const updated = await http.patch(`${url}/${ticket.ticket_id}`, { departmentId: it.id });
    const archived = await http.patch(`${url}/${ticket.ticket_id}`, { departmentId: old.id });

    expect(updated.json()).toMatchObject({ departmentId: it.id, departmentLocked: true, revision: 2 });
    expect(archived.statusCode).toBe(422);
  });

  it('the assignee must be an operator of the workspace', async () => {
    const { workspaceId, http, channel, url } = await setup();
    const viewer = await createUser(app);
    await http.post(`/workspaces/${workspaceId}/members`, { email: viewer.email, role: 'viewer' });
    const outsider = await createUser(app);
    const ticket = (await ingest(app, channel)).json();

    expect((await http.patch(`${url}/${ticket.ticket_id}`, { assigneeId: viewer.id })).statusCode).toBe(422);
    expect((await http.patch(`${url}/${ticket.ticket_id}`, { assigneeId: outsider.id })).statusCode).toBe(422);

    const viewerHttp = client(app, await login(app, viewer));
    expect((await viewerHttp.get(`${url}/${ticket.ticket_id}`)).statusCode).toBe(200);
    expect((await viewerHttp.patch(`${url}/${ticket.ticket_id}`, { priority: 'low' })).statusCode).toBe(403);
  });

  it('fields: an operator pins a value, an invalid one — 422', async () => {
    const { workspaceId, http, user, channel, url } = await setup();
    await http.post(`/workspaces/${workspaceId}/fields`, { entity: 'ticket', key: 'dept_number', label: 'Отдел', type: 'number' });
    const ticket = (await ingest(app, channel, { fields: { dept_number: 100 } })).json();

    const invalid = await http.patch(`${url}/${ticket.ticket_id}`, { fields: { dept_number: 'x' } });
    const valid = await http.patch(`${url}/${ticket.ticket_id}`, { fields: { dept_number: '214' } });

    expect(invalid.statusCode).toBe(422);
    expect(valid.json()).toMatchObject({
      fields: { dept_number: 214 },
      fieldMeta: { dept_number: { source: 'operator', locked: true, userId: user.id } },
      revision: 2,
    });
  });

  it('a ticket cannot be resolved without the required fields', async () => {
    const { workspaceId, http, channel, url } = await setup();
    await http.post(`/workspaces/${workspaceId}/fields`, {
      entity: 'ticket',
      key: 'resolution',
      label: 'Решение',
      type: 'text',
      requiredOn: ['resolve'],
    });
    const ticket = (await ingest(app, channel)).json();

    const blocked = await http.patch(`${url}/${ticket.ticket_id}`, { status: 'resolved' });
    const ok = await http.patch(`${url}/${ticket.ticket_id}`, { status: 'resolved', fields: { resolution: 'Начислили' } });

    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.details).toEqual([expect.objectContaining({ path: 'fields.resolution', code: 'required_field' })]);
    expect(ok.json()).toMatchObject({ status: 'resolved' });
  });

  it('a status change notifies the API source via webhook', async () => {
    const { http, channel, url } = await setup();
    const ticket = (await ingest(app, channel)).json();

    await http.patch(`${url}/${ticket.ticket_id}`, { status: 'pending' });

    const delivery = await prisma.delivery.findFirstOrThrow();
    expect(delivery).toMatchObject({ kind: 'webhook', event: 'ticket.status_changed', status: 'queued', channelId: channel.id });
    expect(delivery.payload).toMatchObject({ ticket: { id: ticket.ticket_id, status: 'pending' }, previous_status: 'new' });
    const queue = app.get<Queue>(getQueueToken(OUTBOUND_QUEUE));
    expect(await queue.getJob(delivery.id)).toBeTruthy();
  });

  it('a foreign ticket — 404', async () => {
    const { channel } = await setup();
    const ticket = (await ingest(app, channel)).json();
    const other = await setupWorkspace(app);

    const response = await other.http.get(`/workspaces/${other.workspaceId}/tickets/${ticket.ticket_id}`);

    expect(response.statusCode).toBe(404);
  });
});
