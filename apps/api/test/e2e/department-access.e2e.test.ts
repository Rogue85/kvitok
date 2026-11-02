import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId } from '../../src/common/ids';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RealtimeService } from '../../src/realtime/realtime.service';
import { StorageService } from '../../src/storage/storage.service';
import {
  client,
  createApiChannel,
  createMailbox,
  createTestApp,
  createUser,
  createWorkspace,
  ingest,
  login,
  resetDb,
  type TestUser,
} from '../helpers';

type Http = ReturnType<typeof client>;

/**
 * Routes that reach ticket data without `:ticketId` in the path; each is scoped by the caller's departments in its service
 * and checked below. A new route of this kind must be added here together with its test.
 */
const SCOPED_ROUTES = [
  'GET workspaces/:workspaceId/tickets',
  'GET workspaces/:workspaceId/tickets/counts',
  'GET workspaces/:workspaceId/tickets/tags',
  'POST workspaces/:workspaceId/tickets/bulk',
  'GET workspaces/:workspaceId/agent/runs/:runId',
  'GET workspaces/:workspaceId/attachments/:attachmentId',
  'GET workspaces/:workspaceId/channels/:channelId/outbox',
  'GET workspaces/:workspaceId/channels/:channelId/outbox/:emailId',
  'GET workspaces/:workspaceId/channels/:channelId/outbox/:emailId/raw',
  'DELETE workspaces/:workspaceId/channels/:channelId/outbox',
  'POST workspaces/:workspaceId/routing-rules/test',
  'POST workspaces/:workspaceId/identification/check',
  'GET workspaces/:workspaceId/analytics',
  'GET workspaces/:workspaceId/events',
  // MCP tools are checked by name in mcp.e2e.test.ts.
  'POST mcp',
  'GET mcp',
  'DELETE mcp',
];

/** Routes that hold no ticket data: configuration, accounts, installation management, ingest by a channel key. */
const UNSCOPED_ROUTES = [
  /^(GET|POST) setup$/,
  /^\w+ tokens/,
  /^\w+ password-links/,
  /^\w+ auth\//,
  /^GET (health|meta)$/,
  /^\w+ admin\/users/,
  /^\w+ notifications\/push/,
  /^POST v1\/ingest\/:channelId$/,
  /^\w+ workspaces(\/:workspaceId)?$/,
  /^\w+ workspaces\/:workspaceId\/(departments|fields|members|integrations|llm-providers|playbooks|agent\/settings|audit|ticket-views|notification-settings)(\/|$)/,
  /^\w+ workspaces\/:workspaceId\/routing-rules(\/:ruleId)?$/,
  /^\w+ workspaces\/:workspaceId\/identification\/(rules|settings)/,
  /^\w+ workspaces\/:workspaceId\/channels(\/:channelId)?(\/(test|poll|rotate-key|rotate-webhook-secret|default-mailbox))?$/,
];

/** Every HTTP route of the app as "METHOD path", without the global prefix. */
function routes(app: NestFastifyApplication): string[] {
  const list: string[] = [];
  const join = (...parts: string[]) => parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as (new (...args: never[]) => unknown) | null;
      if (!controller) continue;
      const prefixes = [Reflect.getMetadata(PATH_METADATA, controller) as string | string[]].flat();
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = (controller.prototype as Record<string, unknown>)[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined) continue;
        for (const prefix of prefixes) {
          for (const path of [Reflect.getMetadata(PATH_METADATA, handler) as string | string[]].flat()) {
            list.push(`${RequestMethod[method]} ${join(prefix, path)}`);
          }
        }
      }
    }
  }
  return [...new Set(list)].sort();
}

describe('department access', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await resetDb(app);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * Departments A, B, triage T and archived C, a ticket in each and one without a department, and members:
   * an admin, operators with A, A+T, C, every department and none, a viewer with B and a superadmin who is not a member.
   */
  async function setup() {
    const admin = await createUser(app);
    const workspaceId = await createWorkspace(app, [{ user: admin, role: 'admin' }]);
    const http = client(app, await login(app, admin));
    const base = `/workspaces/${workspaceId}`;
    const dept = async (key: string, extra: object = {}) => (await http.post(`${base}/departments`, { key, title: key.toUpperCase(), ...extra })).json();
    const departments = { a: await dept('a'), b: await dept('b'), t: await dept('t', { isTriage: true }), c: await dept('c') };

    const channel = await createApiChannel(http, workspaceId);
    const ticket = async (departmentId: string | null, subject: string, tags: string[] = []) => {
      const created = (await ingest(app, channel, { subject })).json();
      await prisma.ticket.update({ where: { id: created.ticket_id }, data: { departmentId, tags } });
      return { id: created.ticket_id as string, number: created.ticket_number as number };
    };
    const tickets = {
      a: await ticket(departments.a.id, 'Ticket A', ['tag-a']),
      b: await ticket(departments.b.id, 'Ticket B', ['tag-b']),
      t: await ticket(departments.t.id, 'Ticket T'),
      c: await ticket(departments.c.id, 'Ticket C'),
      none: await ticket(null, 'Ticket without department'),
    };
    await http.patch(`${base}/departments/${departments.c.id}`, { archived: true });

    const member = async (role: 'operator' | 'viewer', departmentIds: string[] | null) => {
      const user = await createUser(app);
      const added = await http.post(`${base}/members`, {
        userId: user.id,
        role,
        ...(departmentIds ? { departments: { allDepartments: false, departmentIds } } : {}),
      });
      if (added.statusCode !== 201) throw new Error(added.body);
      return { user, http: client(app, await login(app, user)) };
    };
    const members = {
      opA: await member('operator', [departments.a.id]),
      opAT: await member('operator', [departments.a.id, departments.t.id]),
      opC: await member('operator', [departments.c.id]),
      opAll: await member('operator', null),
      opEmpty: await member('operator', []),
      viewerB: await member('viewer', [departments.b.id]),
    };
    const superadmin = await createUser(app, { superadmin: true });
    const root = client(app, await login(app, superadmin));
    return { workspaceId, base, http, admin, departments, channel, tickets, members, root };
  }

  async function ids(http: Http, url: string): Promise<string[]> {
    const response = await http.get(url);
    expect(response.statusCode).toBe(200);
    return response.json().items.map((t: { id: string }) => t.id);
  }

  it('lists, counts, tags and search show only the tickets of the member departments', async () => {
    const { base, tickets, members, http, root } = await setup();
    const all = [tickets.none.id, tickets.c.id, tickets.t.id, tickets.b.id, tickets.a.id];

    expect(await ids(http, `${base}/tickets`)).toEqual(all);
    expect(await ids(root, `${base}/tickets`)).toEqual(all);
    expect(await ids(members.opAll.http, `${base}/tickets`)).toEqual(all);
    expect(await ids(members.opA.http, `${base}/tickets`)).toEqual([tickets.a.id]);
    // The triage department brings tickets without a department.
    expect(await ids(members.opAT.http, `${base}/tickets`)).toEqual([tickets.none.id, tickets.t.id, tickets.a.id]);
    // An archived department keeps its tickets visible to its members.
    expect(await ids(members.opC.http, `${base}/tickets`)).toEqual([tickets.c.id]);
    expect(await ids(members.opEmpty.http, `${base}/tickets`)).toEqual([]);
    expect(await ids(members.viewerB.http, `${base}/tickets`)).toEqual([tickets.b.id]);

    const opA = members.opA.http;
    expect(await ids(opA, `${base}/tickets?departmentId=${tickets.b.id}`)).toEqual([]);
    expect(await ids(opA, `${base}/tickets?departmentId=none`)).toEqual([]);
    expect(await ids(opA, `${base}/tickets?q=%23T-${tickets.b.number}`)).toEqual([]);
    expect(await ids(opA, `${base}/tickets?q=Ticket`)).toEqual([tickets.a.id]);
    expect((await opA.get(`${base}/tickets/counts`)).json()).toMatchObject({ new: 1 });
    expect((await opA.get(`${base}/tickets/tags`)).json()).toEqual(['tag-a']);
    expect((await members.opEmpty.http.get(`${base}/tickets/tags`)).json()).toEqual([]);
    expect((await http.get(`${base}/tickets/tags`)).json()).toEqual(expect.arrayContaining(['tag-a', 'tag-b']));
  });

  it('a ticket of another department answers like a missing one', async () => {
    const { base, tickets, members } = await setup();
    const opA = members.opA.http;
    for (const path of ['', '/timeline', '/agent', '/customer-links']) {
      const hidden = await opA.get(`${base}/tickets/${tickets.b.id}${path}`);
      const missing = await opA.get(`${base}/tickets/${newId()}${path}`);
      expect(hidden.statusCode).toBe(404);
      expect(hidden.json()).toEqual(missing.json());
    }
    expect((await opA.get(`${base}/tickets/${tickets.a.id}`)).statusCode).toBe(200);
    expect((await members.viewerB.http.get(`${base}/tickets/${tickets.b.id}/timeline`)).statusCode).toBe(200);
  });

  it('every route is classified: by a ticket in its path, scoped in its service, or holding no ticket data', async () => {
    const all = routes(app);
    const unclassified = all.filter(
      (route) => !route.includes(':ticketId') && !SCOPED_ROUTES.includes(route) && !UNSCOPED_ROUTES.some((pattern) => pattern.test(route)),
    );
    expect(unclassified).toEqual([]);
    // The lists name existing routes only.
    expect(SCOPED_ROUTES.filter((route) => !all.includes(route))).toEqual([]);
  });

  it('every route with a ticket in its path refuses a ticket of another department and changes nothing', async () => {
    const { workspaceId, tickets, members } = await setup();
    const ticketRoutes = routes(app).filter((route) => route.includes(':ticketId'));
    expect(ticketRoutes.length).toBeGreaterThan(15);
    const before = await prisma.ticket.findUniqueOrThrow({ where: { id: tickets.b.id }, include: { events: true, messages: true } });

    const request = (route: string, ticketId: string) => {
      const [method, path] = route.split(' ') as [string, string];
      const url = `/api/${path}`
        .replace(':workspaceId', workspaceId)
        .replace(':ticketId', ticketId)
        .replace(/:\w+/g, () => newId());
      return app.inject({ method: method as 'GET', url, headers: { cookie: members.opA.http.cookie }, ...(method === 'GET' ? {} : { payload: {} }) });
    };
    for (const route of ticketRoutes) {
      const response = await request(route, tickets.b.id);
      if (response.statusCode === 403) {
        // A route above the operator's role (admins see every department): refused for their own tickets too.
        expect({ route, status: (await request(route, tickets.a.id)).statusCode }).toEqual({ route, status: 403 });
        continue;
      }
      expect({ route, status: response.statusCode, message: response.json().error?.message }).toEqual({ route, status: 404, message: 'Ticket not found' });
    }

    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: tickets.b.id }, include: { events: true, messages: true } });
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.events).toHaveLength(before.events.length);
    expect(after.messages).toHaveLength(before.messages.length);
  });

  it('runs, attachments, outbox emails and checks by a ticket in the body stay within the departments', async () => {
    const { workspaceId, base, http, tickets, members } = await setup();
    const opA = members.opA.http;
    const viewerB = members.viewerB.http;

    const run = await prisma.agentRun.create({
      data: { id: newId(), workspaceId, ticketId: tickets.b.id, mode: 'triage', trigger: { type: 'manual' }, inputRevision: 0 },
    });
    expect((await opA.get(`${base}/agent/runs/${run.id}`)).statusCode).toBe(404);
    expect((await viewerB.get(`${base}/agent/runs/${run.id}`)).statusCode).toBe(200);

    const message = await prisma.message.findFirstOrThrow({ where: { ticketId: tickets.b.id } });
    const storageKey = await app.get(StorageService).put(workspaceId, 'receipt.txt', Buffer.from('receipt'));
    const attachment = await prisma.attachment.create({
      data: { id: newId(), workspaceId, messageId: message.id, filename: 'receipt.txt', contentType: 'text/plain', size: 7, storageKey },
    });
    const loose = await prisma.attachment.create({
      data: { id: newId(), workspaceId, messageId: null, filename: 'loose.txt', contentType: 'text/plain', size: 7, storageKey },
    });
    expect((await opA.get(`${base}/attachments/${attachment.id}`)).statusCode).toBe(404);
    expect((await viewerB.get(`${base}/attachments/${attachment.id}`)).statusCode).toBe(200);
    expect((await viewerB.get(`${base}/attachments/${loose.id}`)).statusCode).toBe(404);
    expect((await members.opAll.http.get(`${base}/attachments/${loose.id}`)).statusCode).toBe(200);

    const mailboxId = await createMailbox(http, workspaceId, { name: 'Test', address: 'test@support.local', transport: 'sandbox', smtp: null });
    const email = (ticketId: string | null) =>
      prisma.sandboxEmail.create({
        data: { id: newId(), workspaceId, channelId: mailboxId, ticketId, fromAddress: 'test@support.local', subject: 'Re', text: 'Hi', raw: Buffer.from('raw'), size: 3 },
      });
    const ofB = await email(tickets.b.id);
    const ticketless = await email(null);
    const outbox = `${base}/channels/${mailboxId}/outbox`;
    const listed = async (h: Http) => (await h.get(outbox)).json().items.map((e: { id: string }) => e.id).sort();
    expect(await listed(opA)).toEqual([]);
    expect(await listed(viewerB)).toEqual([ofB.id]);
    expect(await listed(members.opAll.http)).toEqual([ofB.id, ticketless.id].sort());
    expect((await opA.get(`${outbox}/${ofB.id}`)).statusCode).toBe(404);
    expect((await opA.get(`${outbox}/${ofB.id}/raw`)).statusCode).toBe(404);
    expect((await viewerB.get(`${outbox}/${ofB.id}/raw`)).statusCode).toBe(200);
    expect((await viewerB.get(`${outbox}/${ticketless.id}`)).statusCode).toBe(404);

    for (const url of [`${base}/routing-rules/test`, `${base}/identification/check`]) {
      const hidden = await opA.post(url, { ticketId: tickets.b.id });
      expect(hidden.statusCode).toBe(404);
      expect(hidden.json()).toEqual((await opA.post(url, { ticketId: newId() })).json());
    }
    expect((await viewerB.post(`${base}/routing-rules/test`, { ticketId: tickets.b.id })).statusCode).toBe(200);
  });

  it('analytics count only the tickets of the member departments', async () => {
    const { base, http, members } = await setup();
    const created = async (h: Http) => (await h.get(`${base}/analytics?days=7`)).json().tickets.created;
    expect(await created(http)).toBe(5);
    expect(await created(members.opA.http)).toBe(1);
    expect(await created(members.opAT.http)).toBe(3);
    expect(await created(members.opEmpty.http)).toBe(0);
  });

  it('bulk changes skip the tickets of other departments', async () => {
    const { base, tickets, members } = await setup();
    const opA = members.opA.http;

    const byIds = await opA.post(`${base}/tickets/bulk`, { ids: [tickets.a.id, tickets.b.id], changes: { priority: 'high' } });
    const byFilter = await opA.post(`${base}/tickets/bulk`, { filter: {}, changes: { addTags: ['seen'] } });

    expect(byIds.json()).toEqual({ updated: [tickets.a.id], failed: [] });
    expect(byFilter.json()).toEqual({ updated: [tickets.a.id], failed: [] });
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: tickets.b.id } })).toMatchObject({ priority: 'normal', tags: ['tag-b'] });
  });

  /** Assignees outside the ticket's department are the subject of assignment.e2e; here they lose the ticket. */
  async function withoutGuests(http: Http, base: string) {
    expect((await http.patch(base, { assignment: { assigneesKeepAccess: false } })).statusCode).toBe(200);
  }

  const assigneeIds = async (ticketId: string) =>
    (await prisma.ticketAssignee.findMany({ where: { ticketId }, orderBy: { addedAt: 'asc' } })).map((a) => a.userId);

  it('only a member who sees the ticket can be its assignee', async () => {
    const { base, tickets, departments, members, http } = await setup();
    await withoutGuests(http, base);
    const assign = (ticketId: string, user: TestUser, extra: object = {}) => http.patch(`${base}/tickets/${ticketId}`, { assigneeIds: [user.id], ...extra });

    const refused = await assign(tickets.b.id, members.opA.user);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.details[0]).toMatchObject({ path: 'assigneeIds', message: expect.stringContaining("has no access to the ticket's department") });
    expect((await assign(tickets.b.id, members.opAll.user)).statusCode).toBe(200);
    // The department of the same change counts, also with the same assignee sent again.
    expect((await assign(tickets.t.id, members.opA.user, { departmentId: departments.a.id })).statusCode).toBe(200);
    expect((await assign(tickets.t.id, members.opA.user, { departmentId: departments.b.id })).statusCode).toBe(422);
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: tickets.t.id } })).toMatchObject({ departmentId: departments.a.id });
    expect(await assigneeIds(tickets.t.id)).toEqual([members.opA.user.id]);

    const bulk = await http.post(`${base}/tickets/bulk`, { ids: [tickets.a.id, tickets.b.id], changes: { addAssigneeIds: [members.opA.user.id] } });
    expect(bulk.json().updated).toEqual([tickets.a.id]);
    expect(bulk.json().failed).toEqual([expect.objectContaining({ id: tickets.b.id })]);
  });

  it('moving a ticket to a department its assignee cannot see unassigns them', async () => {
    const { base, http, tickets, departments, members } = await setup();
    await withoutGuests(http, base);
    const opA = members.opA.http;
    expect((await opA.patch(`${base}/tickets/${tickets.a.id}`, { assigneeIds: [members.opA.user.id] })).statusCode).toBe(200);

    // The operator hands the ticket over to a department they cannot see: the answer still shows it, then it is gone.
    const moved = await opA.patch(`${base}/tickets/${tickets.a.id}`, { departmentId: departments.b.id });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ departmentId: departments.b.id, assignees: [] });
    expect((await opA.get(`${base}/tickets/${tickets.a.id}`)).statusCode).toBe(404);
    expect(await ids(members.viewerB.http, `${base}/tickets`)).toEqual([tickets.b.id, tickets.a.id]);

    const events = await prisma.ticketEvent.findMany({ where: { ticketId: tickets.a.id, type: { in: ['department_changed', 'assignees_changed'] } }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => [e.type, e.data])).toEqual([
      ['assignees_changed', { added: [members.opA.user.id], removed: [], source: 'manual' }],
      ['department_changed', { from: departments.a.id, to: departments.b.id }],
      ['assignees_changed', { added: [], removed: [members.opA.user.id], reason: 'department_changed', departmentId: departments.b.id }],
    ]);
  });

  it('a rule neither assigns a ticket to someone who cannot see it nor keeps such an assignee', async () => {
    const { base, http, channel, departments, members } = await setup();
    await withoutGuests(http, base);
    const rule = await http.post(`${base}/routing-rules`, {
      name: 'To B for A',
      stage: 'on_ingest',
      conditions: { field: 'subject', op: 'contains', value: 'route me' },
      effects: [
        { type: 'set_department', departmentKey: 'b' },
        { type: 'assign', userId: members.opA.user.id },
      ],
    });
    expect(rule.statusCode).toBe(201);

    const created = (await ingest(app, channel, { subject: 'Please route me' })).json();
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: created.ticket_id } })).toMatchObject({ departmentId: departments.b.id });
    expect(await assigneeIds(created.ticket_id)).toEqual([]);
  });

  it('restricting a member unassigns their open tickets they can no longer see and is audited', async () => {
    const { base, http, tickets, departments, members } = await setup();
    await withoutGuests(http, base);
    const opAll = members.opAll.user;
    await http.patch(`${base}/tickets/${tickets.a.id}`, { assigneeIds: [opAll.id] });
    await http.patch(`${base}/tickets/${tickets.b.id}`, { assigneeIds: [opAll.id] });
    await http.patch(`${base}/tickets/${tickets.c.id}`, { assigneeIds: [opAll.id], status: 'resolved' });

    const restricted = await http.patch(`${base}/members/${opAll.id}`, { departments: { allDepartments: false, departmentIds: [departments.a.id] } });
    expect(restricted.statusCode).toBe(200);
    expect(restricted.json().departments).toEqual({ allDepartments: false, departmentIds: [departments.a.id] });

    expect(await assigneeIds(tickets.a.id)).toEqual([opAll.id]);
    expect(await assigneeIds(tickets.b.id)).toEqual([]);
    // Closed tickets keep their assignee.
    expect(await assigneeIds(tickets.c.id)).toEqual([opAll.id]);
    expect(await prisma.ticketEvent.findFirst({ where: { ticketId: tickets.b.id, type: 'assignees_changed', actorType: 'user' }, orderBy: { createdAt: 'desc' } })).toMatchObject({
      data: { added: [], removed: [opAll.id], reason: 'access_removed', departmentId: departments.b.id },
    });

    const audit = (await http.get(`${base}/audit?entity=member`)).json().find((e: { entity: string; action: string }) => e.entity === 'member' && e.action === 'update');
    expect(audit.before.departments).toEqual({ allDepartments: true, departmentIds: [] });
    expect(audit.after.departments).toEqual({ allDepartments: false, departmentIds: [departments.a.id] });
  });

  it('moving the triage flag unassigns tickets without a department from those who no longer see them', async () => {
    const { base, http, admin, tickets, departments, members } = await setup();
    await withoutGuests(http, base);
    // A member of the triage department T sees tickets without a department.
    expect((await http.patch(`${base}/tickets/${tickets.none.id}`, { assigneeIds: [members.opAT.user.id] })).statusCode).toBe(200);
    const publish = vi.spyOn(app.get(RealtimeService), 'publish');

    expect((await http.patch(`${base}/departments/${departments.b.id}`, { isTriage: true })).statusCode).toBe(200);

    expect(await assigneeIds(tickets.none.id)).toEqual([]);
    expect(await prisma.ticketEvent.findFirst({ where: { ticketId: tickets.none.id, type: 'assignees_changed' }, orderBy: { createdAt: 'desc' } })).toMatchObject({
      actorType: 'user',
      actorId: admin.id,
      data: { added: [], removed: [members.opAT.user.id], reason: 'triage_changed' },
    });
    expect((await members.opAT.http.get(`${base}/tickets/${tickets.none.id}`)).statusCode).toBe(404);
    expect((await members.viewerB.http.get(`${base}/tickets/${tickets.none.id}`)).statusCode).toBe(200);

    // The members of the old and the new triage department reload their access.
    const published = publish.mock.calls.map(([, event]) => event);
    expect(published).toContainEqual({ type: 'ticket.updated', ticketId: tickets.none.id });
    expect(published).toContainEqual({ type: 'ticket.access', ticketId: tickets.none.id, userIds: [members.opAT.user.id] });
    expect(published.filter((event) => event.type === 'access.changed').map((event) => 'userId' in event && event.userId).sort()).toEqual(
      [members.opAT.user.id, members.viewerB.user.id].sort(),
    );

    // A change that keeps the triage department changes nobody's access.
    publish.mockClear();
    expect((await http.patch(`${base}/departments/${departments.b.id}`, { title: 'B2' })).statusCode).toBe(200);
    expect(publish.mock.calls.filter(([, event]) => event.type === 'access.changed')).toEqual([]);
  });

  it('validates departments: own workspace only, a list or every one, administrators always every one', async () => {
    const { base, http, departments, members } = await setup();
    const opA = members.opA.user;
    const other = await createWorkspace(app, []);
    const foreign = await prisma.department.create({ data: { id: newId(), workspaceId: other, key: 'x', title: 'X' } });
    const patch = (body: object) => http.patch(`${base}/members/${opA.id}`, body);

    expect((await patch({ departments: { allDepartments: false, departmentIds: [foreign.id] } })).statusCode).toBe(422);
    expect((await patch({ departments: { allDepartments: true, departmentIds: [departments.a.id] } })).statusCode).toBe(422);
    expect((await patch({ role: 'admin', departments: { allDepartments: false, departmentIds: [departments.a.id] } })).statusCode).toBe(422);
    // A promoted member gets every department, and keeps it when demoted.
    expect((await patch({ role: 'admin' })).json().departments).toEqual({ allDepartments: true, departmentIds: [] });
    expect((await patch({ role: 'operator' })).json().departments).toEqual({ allDepartments: true, departmentIds: [] });
    // The database refuses a restricted admin too.
    await expect(prisma.membership.updateMany({ where: { userId: opA.id }, data: { role: 'admin', allDepartments: false } })).rejects.toThrow();

    const invited = await http.post(`${base}/members`, {
      email: 'new@example.com',
      name: 'New',
      role: 'viewer',
      departments: { allDepartments: false, departmentIds: [departments.b.id, departments.b.id] },
    });
    expect(invited.statusCode).toBe(201);
    expect(invited.json().member.departments).toEqual({ allDepartments: false, departmentIds: [departments.b.id] });
  });

  it('superadmins set departments on memberships too', async () => {
    const { workspaceId, departments, root } = await setup();
    const user = await createUser(app);
    const put = (body: object) => root.put(`/admin/users/${user.id}/memberships/${workspaceId}`, body);

    const created = await put({ role: 'operator', departments: { allDepartments: false, departmentIds: [departments.a.id] } });
    expect(created.json().memberships[0].departments).toEqual({ allDepartments: false, departmentIds: [departments.a.id] });
    // Without departments an existing membership keeps them.
    expect((await put({ role: 'viewer' })).json().memberships[0]).toMatchObject({
      role: 'viewer',
      departments: { allDepartments: false, departmentIds: [departments.a.id] },
    });
  });

  it('/auth/me tells the web interface which departments the user sees', async () => {
    const { workspaceId, departments, members, root } = await setup();
    const scope = async (h: Http) =>
      (await h.get('/auth/me')).json().workspaces.find((w: { workspaceId: string }) => w.workspaceId === workspaceId).departments;

    expect(await scope(members.opA.http)).toEqual({ all: false, departmentIds: [departments.a.id], unrouted: false });
    const both = await scope(members.opAT.http);
    expect({ ...both, departmentIds: both.departmentIds.toSorted() }).toEqual({
      all: false,
      departmentIds: [departments.a.id, departments.t.id].toSorted(),
      unrouted: true,
    });
    expect(await scope(members.opAll.http)).toEqual({ all: true });
    expect(await scope(root)).toEqual({ all: true });
  });
});
