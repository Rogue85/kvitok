import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../src/common/ids';
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
    await http.patch(`${url}/${a.ticket_id}`, { assigneeIds: [user.id], status: 'pending' });

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

  it('list: lists of values, tags, channels, agent state, dates and sorting', async () => {
    const { workspaceId, http, user, channel, url } = await setup();
    const other = await createApiChannel(http, workspaceId);
    const dept = (await http.post(`/workspaces/${workspaceId}/departments`, { key: 'it', title: 'ИТ' })).json();
    const a = (await ingest(app, channel, { subject: 'A' })).json().ticket_id as string;
    const b = (await ingest(app, other, { subject: 'B' })).json().ticket_id as string;
    const c = (await ingest(app, channel, { subject: 'C' })).json().ticket_id as string;
    await http.patch(`${url}/${a}`, { assigneeIds: [user.id], departmentId: dept.id, priority: 'urgent', tags: ['vip', 'bonus'] });
    await http.patch(`${url}/${b}`, { priority: 'high', tags: ['bonus'] });
    await prisma.ticket.update({ where: { id: a }, data: { lastMessageAt: new Date('2026-01-10T10:00:00Z'), createdAt: new Date('2026-01-01T10:00:00Z') } });
    await prisma.ticket.update({ where: { id: b }, data: { agentState: 'failed' } });

    const ids = async (query: string) => (await http.get(`${url}?${query}`)).json().items.map((t: { id: string }) => t.id);

    expect(await ids(`assignee=me,none`)).toEqual([c, b, a]);
    expect(await ids(`departmentId=${dept.id},none`)).toEqual([c, b, a]);
    expect(await ids(`departmentId=none`)).toEqual([c, b]);
    expect(await ids('priority=high,urgent')).toEqual([b, a]);
    expect(await ids('tags=vip')).toEqual([a]);
    expect(await ids('tags=vip,bonus')).toEqual([b, a]);
    expect(await ids(`channelId=${other.id}`)).toEqual([b]);
    expect(await ids('agentState=failed')).toEqual([b]);
    expect(await ids(`updatedTo=${encodeURIComponent('2026-02-01T00:00:00+03:00')}`)).toEqual([a]);
    expect(await ids(`createdFrom=${encodeURIComponent('2026-02-01T00:00:00Z')}`)).toEqual([c, b]);
    expect(await ids('sort=oldest')).toEqual([a, b, c]);
    expect(await ids('sort=priority')).toEqual([a, b, c]);
    expect((await http.get(`${url}?priority=huge`)).statusCode).toBe(422);
    expect((await http.get(`/workspaces/${workspaceId}/tickets/tags`)).json()).toEqual(['bonus', 'vip']);
    expect((await http.get(`${url}/counts?status=pending&priority=high,urgent`)).json()).toEqual({ new: 2, open: 0, pending: 0, resolved: 0, closed: 0 });
  });

  it('list: waiting for the operator', async () => {
    const { workspaceId, http, channel, url } = await setup();
    const a = (await ingest(app, channel)).json().ticket_id as string;
    const b = (await ingest(app, channel)).json().ticket_id as string;
    const run = await prisma.agentRun.create({
      data: { id: newId(), workspaceId, ticketId: a, mode: 'triage', trigger: { type: 'ticket_created' }, status: 'applied', inputRevision: 0 },
    });
    await prisma.agentQuestion.create({ data: { id: newId(), workspaceId, ticketId: a, runId: run.id, text: 'Какой заказ?' } });

    const list = (await http.get(`${url}?attention=1`)).json();

    expect(list.items.map((t: { id: string }) => t.id)).toEqual([a]);
    expect(list.items[0]).toMatchObject({ attention: true });
    expect((await http.get(url)).json().items.find((t: { id: string }) => t.id === b)).toMatchObject({ attention: false });
  });

  it('bulk: one change for many tickets, each through the single update path', async () => {
    const { workspaceId, http, user, channel, url } = await setup();
    await http.post(`/workspaces/${workspaceId}/fields`, { entity: 'ticket', key: 'resolution', label: 'Решение', type: 'text', requiredOn: ['resolve'] });
    const a = (await ingest(app, channel)).json();
    const b = (await ingest(app, channel)).json();
    await http.patch(`${url}/${a.ticket_id}`, { tags: ['vip', 'old'], fields: { resolution: 'Готово' } });

    const tagged = await http.post(`${url}/bulk`, {
      ids: [a.ticket_id, b.ticket_id],
      changes: { addAssigneeIds: [user.id], priority: 'high', addTags: ['bonus'], removeTags: ['old'] },
    });
    const resolved = (await http.post(`${url}/bulk`, { ids: [a.ticket_id, b.ticket_id], changes: { status: 'resolved' } })).json();

    expect(tagged.statusCode).toBe(200);
    expect(tagged.json()).toEqual({ updated: [a.ticket_id, b.ticket_id], failed: [] });
    const [ta, tb] = await Promise.all([a, b].map(async (x) => (await http.get(`${url}/${x.ticket_id}`)).json()));
    expect(ta).toMatchObject({ assignees: [{ id: user.id, source: 'manual' }], priority: 'high', tags: ['vip', 'bonus'], status: 'resolved' });
    expect(tb).toMatchObject({ assignees: [{ id: user.id, source: 'manual' }], priority: 'high', tags: ['bonus'], status: 'new' });
    expect(resolved).toEqual({
      updated: [a.ticket_id],
      failed: [{ id: b.ticket_id, number: b.ticket_number, message: expect.stringContaining('Решение') }],
    });
    expect(await prisma.ticketEvent.count({ where: { ticketId: b.ticket_id, type: 'assignees_changed', actorId: user.id } })).toBe(1);
    expect(await prisma.delivery.count({ where: { event: 'ticket.status_changed' } })).toBe(1);
  });

  it('bulk: by the list filter; invalid requests and roles', async () => {
    const { workspaceId, http, channel, url } = await setup();
    const a = (await ingest(app, channel)).json().ticket_id as string;
    const b = (await ingest(app, channel)).json().ticket_id as string;
    await http.patch(`${url}/${a}`, { status: 'pending' });
    const viewer = await createUser(app);
    await http.post(`/workspaces/${workspaceId}/members`, { userId: viewer.id, role: 'viewer' });
    const viewerHttp = client(app, await login(app, viewer));

    const byFilter = (await http.post(`${url}/bulk`, { filter: { status: 'new,open', page: '3' }, changes: { priority: 'low' } })).json();

    expect(byFilter).toEqual({ updated: [b], failed: [] });
    expect((await http.post(`${url}/bulk`, { ids: [a], changes: {} })).statusCode).toBe(422);
    expect((await http.post(`${url}/bulk`, { ids: [a], filter: {}, changes: { priority: 'low' } })).statusCode).toBe(422);
    expect((await http.post(`${url}/bulk`, { ids: [a], changes: { addAssigneeIds: [viewer.id] } })).json()).toMatchObject({ updated: [], failed: [{ id: a }] });
    expect((await viewerHttp.post(`${url}/bulk`, { ids: [a], changes: { priority: 'low' } })).statusCode).toBe(403);
  });

  it('bulk: tickets of another workspace are not touched', async () => {
    const { http, channel, url } = await setup();
    const foreign = (await ingest(app, channel)).json().ticket_id as string;
    const other = await setupWorkspace(app);

    const result = (await other.http.post(`/workspaces/${other.workspaceId}/tickets/bulk`, { ids: [foreign], changes: { priority: 'low' } })).json();

    expect(result).toEqual({ updated: [], failed: [] });
    expect((await http.get(`${url}/${foreign}`)).json()).toMatchObject({ priority: 'normal' });
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
    await http.post(`/workspaces/${workspaceId}/members`, { userId: viewer.id, role: 'viewer' });
    const outsider = await createUser(app);
    const ticket = (await ingest(app, channel)).json();

    expect((await http.patch(`${url}/${ticket.ticket_id}`, { assigneeIds: [viewer.id] })).statusCode).toBe(422);
    expect((await http.patch(`${url}/${ticket.ticket_id}`, { assigneeIds: [outsider.id] })).statusCode).toBe(422);

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
