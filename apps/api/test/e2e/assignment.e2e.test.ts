import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RealtimeService } from '../../src/realtime/realtime.service';
import { client, createApiChannel, createTestApp, createUser, createWorkspace, ingest, login, resetDb, type TestUser } from '../helpers';

type Http = ReturnType<typeof client>;

describe('ticket assignment', () => {
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
   * Departments A and B hand tickets out in turn, M by hand, T is triage. Operators: two of A who accept tickets,
   * one of A who does not, one of B who accepts.
   */
  async function setup() {
    const admin = await createUser(app);
    const workspaceId = await createWorkspace(app, [{ user: admin, role: 'admin' }]);
    const http = client(app, await login(app, admin));
    const base = `/workspaces/${workspaceId}`;
    const dept = async (key: string, extra: object = {}) => (await http.post(`${base}/departments`, { key, title: key.toUpperCase(), ...extra })).json();
    const departments = {
      a: await dept('a', { assignmentMode: 'round_robin' }),
      b: await dept('b', { assignmentMode: 'round_robin' }),
      m: await dept('m'),
      t: await dept('t', { isTriage: true }),
    };
    const channel = await createApiChannel(http, workspaceId, { webhookUrl: 'https://backend.example.com/hook' });

    const member = async (departmentIds: string[], accepting: boolean) => {
      const user = await createUser(app);
      const added = await http.post(`${base}/members`, { userId: user.id, role: 'operator', departments: { allDepartments: false, departmentIds } });
      if (added.statusCode !== 201) throw new Error(added.body);
      const memberHttp = client(app, await login(app, user));
      if (accepting) expect((await memberHttp.put(`${base}/members/${user.id}/accepting-tickets`, { accepting: true })).statusCode).toBe(200);
      return { user, http: memberHttp };
    };
    const members = {
      a1: await member([departments.a.id], true),
      a2: await member([departments.a.id], true),
      aOff: await member([departments.a.id], false),
      b: await member([departments.b.id], true),
    };

    /** A ticket put into a department directly, as if routed before: nobody handed it out. */
    const ticket = async (departmentId: string | null, subject = 'Вопрос') => {
      const created = (await ingest(app, channel, { subject })).json();
      await prisma.ticket.update({ where: { id: created.ticket_id }, data: { departmentId } });
      return created.ticket_id as string;
    };
    const move = (ticketId: string, departmentId: string, as: Http = http) => as.patch(`${base}/tickets/${ticketId}`, { departmentId });
    return { admin, workspaceId, http, base, departments, channel, members, ticket, move };
  }

  async function assignees(ticketId: string) {
    return (await prisma.ticketAssignee.findMany({ where: { ticketId }, orderBy: [{ addedAt: 'asc' }, { userId: 'asc' }] })).map((a) => ({
      userId: a.userId,
      source: a.source,
    }));
  }

  const ids = (...users: TestUser[]) => users.map((u) => u.id).sort();

  it('a department hands tickets out in turn to the members who accept them', async () => {
    const { base, http, departments, members, ticket, move } = await setup();
    // Disabled members and viewers never get tickets, even accepting ones.
    const disabled = await createUser(app);
    await http.post(`${base}/members`, { userId: disabled.id, role: 'operator', departments: { allDepartments: false, departmentIds: [departments.a.id] } });
    await http.put(`${base}/members/${disabled.id}/accepting-tickets`, { accepting: true });
    await prisma.user.update({ where: { id: disabled.id }, data: { disabledAt: new Date() } });
    const viewer = await createUser(app);
    await http.post(`${base}/members`, { userId: viewer.id, role: 'viewer', departments: { allDepartments: false, departmentIds: [departments.a.id] } });
    await http.put(`${base}/members/${viewer.id}/accepting-tickets`, { accepting: true });

    const order = ids(members.a1.user, members.a2.user);
    const got: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const id = await ticket(departments.m.id);
      const moved = await move(id, departments.a.id);
      expect(moved.statusCode).toBe(200);
      expect(moved.json().assignees).toEqual([expect.objectContaining({ source: 'auto' })]);
      got.push(moved.json().assignees[0].id);
    }
    expect(got).toEqual([order[0], order[1], order[0]]);

    const last = await prisma.ticketEvent.findFirst({ where: { type: 'assignees_changed' }, orderBy: { createdAt: 'desc' } });
    expect(last).toMatchObject({ actorType: 'system', data: { added: [order[0]], removed: [], source: 'auto', reason: 'auto', departmentId: departments.a.id } });
  });

  it('nobody gets a ticket of a department that assigns by hand, or when nobody accepts tickets', async () => {
    const { base, departments, members, ticket, move } = await setup();
    const manual = await ticket(departments.t.id);
    expect((await move(manual, departments.m.id)).json().assignees).toEqual([]);

    for (const m of [members.a1, members.a2]) await m.http.put(`${base}/members/${m.user.id}/accepting-tickets`, { accepting: false });
    const idle = await ticket(departments.m.id);
    expect((await move(idle, departments.a.id)).json().assignees).toEqual([]);
    // Turning the switch on does not hand out what is already waiting.
    await members.a1.http.put(`${base}/members/${members.a1.user.id}/accepting-tickets`, { accepting: true });
    expect(await assignees(idle)).toEqual([]);
  });

  it('two tickets moved at once go to different members', async () => {
    const { departments, ticket, move, members } = await setup();
    const [x, y] = [await ticket(departments.m.id), await ticket(departments.m.id)];
    const moved = await Promise.all([move(x, departments.a.id), move(y, departments.a.id)]);
    expect(moved.map((r) => r.json().assignees[0].id).sort()).toEqual(ids(members.a1.user, members.a2.user));
  });

  it('an assignee keeps a ticket moved to a department they cannot see, and that department adds its own', async () => {
    const { base, departments, members, ticket, move } = await setup();
    const id = await ticket(departments.a.id);
    const otherB = await ticket(departments.b.id, 'Чужой тикет');
    expect((await members.a1.http.patch(`${base}/tickets/${id}`, { assigneeIds: [members.a1.user.id] })).statusCode).toBe(200);
    const publish = vi.spyOn(app.get(RealtimeService), 'publish');

    const moved = await move(id, departments.b.id, members.a1.http);
    expect(moved.statusCode).toBe(200);
    expect(moved.json().assignees).toEqual([
      expect.objectContaining({ id: members.a1.user.id, source: 'manual' }),
      expect.objectContaining({ id: members.b.user.id, source: 'auto' }),
    ]);
    expect(publish.mock.calls.map(([, event]) => event)).toContainEqual({ type: 'ticket.access', ticketId: id, userIds: [members.b.user.id] });

    // The guest sees the ticket and works on it, but not the rest of department B.
    expect((await members.a1.http.get(`${base}/tickets/${id}`)).statusCode).toBe(200);
    const list = (await members.a1.http.get(`${base}/tickets`)).json().items.map((t: { id: string }) => t.id);
    expect(list).toContain(id);
    expect(list).not.toContain(otherB);
    expect((await members.a1.http.get(`${base}/tickets/${otherB}`)).statusCode).toBe(404);
    expect((await members.a1.http.post(`${base}/tickets/${id}/agent/messages`, { body: 'Передал складу' })).statusCode).toBe(201);

    // Leaving the ticket takes the access away.
    expect((await members.a1.http.patch(`${base}/tickets/${id}`, { assigneeIds: [members.b.user.id] })).statusCode).toBe(200);
    expect((await members.a1.http.get(`${base}/tickets/${id}`)).statusCode).toBe(404);
  });

  it('a member of another department can be called in without moving the ticket', async () => {
    const { base, http, departments, members, ticket } = await setup();
    const id = await ticket(departments.a.id);
    const called = await members.a1.http.patch(`${base}/tickets/${id}`, { assigneeIds: [members.a1.user.id, members.b.user.id] });
    expect(called.statusCode).toBe(200);
    expect(called.json().assignees.map((a: { id: string }) => a.id).sort()).toEqual(ids(members.a1.user, members.b.user));
    expect((await members.b.http.get(`${base}/tickets/${id}`)).statusCode).toBe(200);

    // Without the setting they could not be called in.
    await http.patch(base, { assignment: { assigneesKeepAccess: false } });
    const other = await ticket(departments.a.id);
    expect((await http.patch(`${base}/tickets/${other}`, { assigneeIds: [members.b.user.id] })).statusCode).toBe(422);
  });

  it('a distributor pick who never worked on the ticket leaves it on a move; one who did stays', async () => {
    const { base, departments, members, ticket, move } = await setup();
    const untouched = await ticket(departments.m.id);
    const picked = (await move(untouched, departments.a.id)).json().assignees[0].id as string;
    expect((await move(untouched, departments.b.id)).json().assignees).toEqual([expect.objectContaining({ id: members.b.user.id, source: 'auto' })]);
    expect(await prisma.ticketEvent.findFirst({ where: { ticketId: untouched, type: 'assignees_changed', data: { path: ['reason'], equals: 'department_changed' } } })).toMatchObject({
      data: { removed: [picked] },
    });

    const worked = await ticket(departments.m.id);
    const pick = (await move(worked, departments.a.id)).json().assignees[0].id as string;
    const worker = [members.a1, members.a2].find((m) => m.user.id === pick)!;
    expect((await worker.http.post(`${base}/tickets/${worked}/agent/messages`, { body: 'Смотрю' })).statusCode).toBe(201);
    expect((await move(worked, departments.b.id)).json().assignees.map((a: { id: string }) => a.id)).toEqual([pick, members.b.user.id]);
  });

  it('an operator who works on a ticket becomes its assignee; other changes do not assign', async () => {
    const { base, http, departments, members, ticket } = await setup();
    // Put in directly: nobody handed it out.
    const id = await ticket(departments.a.id);

    expect((await http.patch(`${base}/tickets/${id}`, { status: 'open', priority: 'high', tags: ['x'] })).statusCode).toBe(200);
    expect((await http.post(`${base}/tickets/bulk`, { ids: [id], changes: { priority: 'low' } })).statusCode).toBe(200);
    expect(await assignees(id)).toEqual([]);

    expect((await members.a1.http.post(`${base}/tickets/${id}/replies`, { bodyHtml: '<p>Здравствуйте!</p>', via: ['source'] })).statusCode).toBe(201);
    expect((await members.a2.http.post(`${base}/tickets/${id}/agent/messages`, { body: 'Проверь чек' })).statusCode).toBe(201);
    expect(await assignees(id)).toEqual([
      { userId: members.a1.user.id, source: 'action' },
      { userId: members.a2.user.id, source: 'action' },
    ]);
    expect(await prisma.ticketAssignee.count({ where: { ticketId: id, actedAt: { not: null } } })).toBe(2);
    expect(await prisma.ticketEvent.findFirst({ where: { ticketId: id, type: 'assignees_changed', actorId: members.a1.user.id } })).toMatchObject({
      data: { added: [members.a1.user.id], source: 'action', reason: 'active' },
    });

    // Turned off: nobody joins by working, an assignee still gets the time of their work.
    await http.patch(base, { assignment: { assignActiveOperator: false } });
    await members.aOff.http.post(`${base}/tickets/${id}/agent/messages`, { body: 'Тоже смотрю' });
    expect((await assignees(id)).map((a) => a.userId)).not.toContain(members.aOff.user.id);
  });

  it('turning off assignees access removes guests from open tickets and hands them out again', async () => {
    const { base, http, departments, members, ticket, move } = await setup();
    const movedAway = await ticket(departments.a.id);
    await http.patch(`${base}/tickets/${movedAway}`, { assigneeIds: [members.a1.user.id] });
    await move(movedAway, departments.b.id);
    const calledIn = await ticket(departments.a.id);
    await http.patch(`${base}/tickets/${calledIn}`, { assigneeIds: [members.b.user.id] });
    const publish = vi.spyOn(app.get(RealtimeService), 'publish');

    const updated = await http.patch(base, { assignment: { assigneesKeepAccess: false } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().assignment).toEqual({ assignActiveOperator: true, assigneesKeepAccess: false });

    expect(await assignees(movedAway)).toEqual([{ userId: members.b.user.id, source: 'auto' }]);
    expect(await assignees(calledIn)).toEqual([{ userId: expect.stringMatching(/./), source: 'auto' }]);
    expect(ids(members.a1.user, members.a2.user)).toContain((await assignees(calledIn))[0]!.userId);
    expect((await members.a1.http.get(`${base}/tickets/${movedAway}`)).statusCode).toBe(404);
    const accessChanged = publish.mock.calls.map(([, event]) => event).filter((event) => event.type === 'access.changed');
    expect(accessChanged.map((event) => 'userId' in event && event.userId).sort()).toEqual(ids(members.a1.user, members.a2.user, members.aOff.user, members.b.user));
  });

  it('a rule adds an assignee, and the department still hands the ticket to one of its own', async () => {
    const { base, http, channel, departments, members } = await setup();
    await http.post(`${base}/routing-rules`, {
      name: 'VIP',
      stage: 'on_ingest',
      conditions: { field: 'subject', op: 'contains', value: 'VIP' },
      effects: [
        { type: 'set_department', departmentKey: 'a' },
        { type: 'assign', userId: members.b.user.id },
      ],
    });
    const created = (await ingest(app, channel, { subject: 'VIP гость' })).json();
    const list = await assignees(created.ticket_id);
    expect(list[0]).toEqual({ userId: members.b.user.id, source: 'rule' });
    expect(list[1]).toMatchObject({ source: 'auto' });
    expect(ids(members.a1.user, members.a2.user)).toContain(list[1]!.userId);
  });

  it('members switch accepting tickets for themselves, admins for anyone', async () => {
    const { base, http, workspaceId, members } = await setup();
    const me = async (h: Http) => (await h.get('/auth/me')).json().workspaces.find((w: { workspaceId: string }) => w.workspaceId === workspaceId);

    expect((await me(members.aOff.http)).acceptingTickets).toBe(false);
    expect((await members.aOff.http.put(`${base}/members/${members.aOff.user.id}/accepting-tickets`, { accepting: true })).json()).toMatchObject({
      acceptingTickets: true,
    });
    expect((await me(members.aOff.http)).acceptingTickets).toBe(true);
    expect((await members.aOff.http.put(`${base}/members/${members.a1.user.id}/accepting-tickets`, { accepting: false })).statusCode).toBe(403);
    expect((await http.put(`${base}/members/${members.a1.user.id}/accepting-tickets`, { accepting: false })).statusCode).toBe(200);
    const listed = (await http.get(`${base}/members`)).json().find((m: { userId: string }) => m.userId === members.a1.user.id);
    expect(listed.acceptingTickets).toBe(false);

    const audit = (await http.get(`${base}/audit?entity=member`)).json().find((e: { entityId: string; action: string }) => e.entityId === members.a1.user.id && e.action === 'update');
    expect(audit).toMatchObject({ before: { acceptingTickets: true }, after: { acceptingTickets: false } });
  });

  it('filters the list by any of the assignees', async () => {
    const { base, http, departments, members, ticket } = await setup();
    const both = await ticket(departments.a.id);
    const none = await ticket(departments.a.id);
    await http.patch(`${base}/tickets/${both}`, { assigneeIds: [members.a1.user.id, members.a2.user.id] });

    const list = async (query: string) => (await http.get(`${base}/tickets?${query}`)).json().items.map((t: { id: string }) => t.id);
    expect(await list(`assignee=${members.a2.user.id}`)).toEqual([both]);
    expect(await list('assignee=none')).toEqual([none]);
    expect((await members.a1.http.get(`${base}/tickets?assignee=me`)).json().items.map((t: { id: string }) => t.id)).toEqual([both]);
  });

  it('a guest sees their ticket and what hangs on it, never its neighbors, and loses it when the setting goes off', async () => {
    const { base, http, departments, members, ticket } = await setup();
    const own = await ticket(departments.b.id, 'Гостевой');
    const closed = await ticket(departments.b.id, 'Закрытый гостевой');
    const neighbor = await ticket(departments.b.id, 'Сосед');
    await prisma.ticket.update({ where: { id: own }, data: { tags: ['guest-tag'] } });
    await prisma.ticket.update({ where: { id: neighbor }, data: { tags: ['neighbor-tag'] } });
    await http.patch(`${base}/tickets/${own}`, { addAssigneeIds: [members.a1.user.id] });
    await http.patch(`${base}/tickets/${closed}`, { addAssigneeIds: [members.a1.user.id], status: 'closed' });
    const guest = members.a1.http;

    for (const path of ['', '/timeline', '/agent']) {
      expect((await guest.get(`${base}/tickets/${own}${path}`)).statusCode).toBe(200);
      expect((await guest.get(`${base}/tickets/${neighbor}${path}`)).statusCode).toBe(404);
    }
    expect((await guest.get(`${base}/tickets/${closed}`)).statusCode).toBe(200);
    const tags = (await guest.get(`${base}/tickets/tags`)).json();
    expect(tags).toContain('guest-tag');
    expect(tags).not.toContain('neighbor-tag');
    expect((await guest.get(`${base}/tickets/counts?view=all`)).json()).toMatchObject({ new: 1, closed: 1 });

    await http.patch(base, { assignment: { assigneesKeepAccess: false } });
    expect((await guest.get(`${base}/tickets/${own}`)).statusCode).toBe(404);
    // The closed one keeps its assignee row, but the setting no longer turns it into access.
    expect((await guest.get(`${base}/tickets/${closed}`)).statusCode).toBe(404);
    expect(await prisma.ticketAssignee.count({ where: { ticketId: closed, userId: members.a1.user.id } })).toBe(1);
  });

  it('removing a member clears their assignments; invited again, they do not get their old tickets back', async () => {
    const { base, http, departments, members, ticket } = await setup();
    const open = await ticket(departments.a.id);
    const closed = await ticket(departments.b.id);
    await http.patch(`${base}/tickets/${open}`, { assigneeIds: [members.a1.user.id] });
    await http.patch(`${base}/tickets/${closed}`, { assigneeIds: [members.a1.user.id], status: 'closed' });

    expect((await http.delete(`${base}/members/${members.a1.user.id}`)).statusCode).toBe(204);
    expect(await prisma.ticketAssignee.count({ where: { userId: members.a1.user.id } })).toBe(0);
    // The open ticket went to the other member of A who accepts tickets.
    expect(await assignees(open)).toEqual([{ userId: members.a2.user.id, source: 'auto' }]);
    expect(await prisma.ticketEvent.findFirst({ where: { ticketId: open, type: 'assignees_changed', data: { path: ['reason'], equals: 'access_removed' } } })).toMatchObject({
      data: { removed: [members.a1.user.id] },
    });

    await http.post(`${base}/members`, { userId: members.a1.user.id, role: 'operator', departments: { allDepartments: false, departmentIds: [departments.m.id] } });
    expect((await members.a1.http.get(`${base}/tickets/${closed}`)).statusCode).toBe(404);
    expect((await members.a1.http.get(`${base}/tickets/${open}`)).statusCode).toBe(404);
  });

  it('a change of one ticket adds and removes assignees relative to what they are when it applies', async () => {
    const { base, http, departments, members, ticket } = await setup();
    const id = await ticket(departments.a.id);
    const url = `${base}/tickets/${id}`;

    // Two pickers that saw an empty list each add someone: both stay.
    const both = await Promise.all([http.patch(url, { addAssigneeIds: [members.a1.user.id] }), http.patch(url, { addAssigneeIds: [members.a2.user.id] })]);
    expect(both.map((r) => r.statusCode)).toEqual([200, 200]);
    expect((await assignees(id)).map((a) => a.userId).sort()).toEqual(ids(members.a1.user, members.a2.user));

    expect((await http.patch(url, { removeAssigneeIds: [members.a1.user.id] })).json().assignees.map((a: { id: string }) => a.id)).toEqual([members.a2.user.id]);
    expect((await http.patch(url, { assigneeIds: [], addAssigneeIds: [members.a1.user.id] })).statusCode).toBe(422);
    const old = await http.patch(url, { assigneeId: members.a1.user.id });
    expect(old.statusCode).toBe(422);
    expect(old.body).toContain('assigneeIds');
    const many = Array.from({ length: 21 }, (_, i) => `u${i}`);
    expect((await http.patch(url, { assigneeIds: many })).statusCode).toBe(422);

    const bulk = await http.post(`${base}/tickets/bulk`, { ids: [id], changes: { addAssigneeIds: [members.aOff.user.id], removeAssigneeIds: [members.a2.user.id] } });
    expect(bulk.json()).toEqual({ updated: [id], failed: [] });
    expect((await assignees(id)).map((a) => a.userId)).toEqual([members.aOff.user.id]);
  });

  it('a reopened ticket without an assignee of its department is handed out', async () => {
    const { base, http, channel, departments, members } = await setup();
    const created = (await ingest(app, channel, { subject: 'Снова', conversation_external_id: 'reopen-1' })).json();
    await prisma.ticket.update({ where: { id: created.ticket_id }, data: { departmentId: departments.a.id, status: 'resolved', resolvedAt: new Date() } });

    await ingest(app, channel, { conversation_external_id: 'reopen-1', body: 'Не помогло' });
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: created.ticket_id } })).toMatchObject({ status: 'open' });
    expect(await assignees(created.ticket_id)).toEqual([{ userId: expect.any(String), source: 'auto' }]);

    // Reopened by an operator the same way.
    const other = (await ingest(app, channel, { subject: 'Закрыт' })).json().ticket_id as string;
    await prisma.ticket.update({ where: { id: other }, data: { departmentId: departments.b.id, status: 'closed', resolvedAt: new Date() } });
    expect((await http.patch(`${base}/tickets/${other}`, { status: 'open' })).json().assignees).toEqual([expect.objectContaining({ id: members.b.user.id, source: 'auto' })]);
  });

  it('a pick the operator names in a move stays theirs', async () => {
    const { base, http, departments, ticket, move } = await setup();
    const id = await ticket(departments.m.id);
    const pick = (await move(id, departments.a.id)).json().assignees[0].id as string;
    const moved = await http.patch(`${base}/tickets/${id}`, { departmentId: departments.b.id, assigneeIds: [pick] });
    expect(moved.json().assignees.map((a: { id: string; source: string }) => [a.id, a.source])).toEqual([
      [pick, 'manual'],
      [expect.any(String), 'auto'],
    ]);
  });

  it('a change of a member touches only the tickets it affects; a viewer stops counting as the department\'s assignee', async () => {
    const { base, http, departments, members, ticket } = await setup();
    // a1 is a guest in B, where nobody accepted the ticket: an unrelated change of a1 must not hand it out.
    await http.put(`${base}/members/${members.b.user.id}/accepting-tickets`, { accepting: false });
    const guestTicket = await ticket(departments.b.id);
    await http.patch(`${base}/tickets/${guestTicket}`, { assigneeIds: [members.a1.user.id] });
    await http.put(`${base}/members/${members.b.user.id}/accepting-tickets`, { accepting: true });
    await http.patch(`${base}/members/${members.a1.user.id}`, { departments: { allDepartments: false, departmentIds: [departments.a.id, departments.m.id] } });
    expect(await assignees(guestTicket)).toEqual([{ userId: members.a1.user.id, source: 'manual' }]);

    // Demoted to viewer: their ticket in A goes to the other member of A who accepts tickets.
    const own = await ticket(departments.a.id);
    await http.patch(`${base}/tickets/${own}`, { assigneeIds: [members.a1.user.id] });
    await http.patch(`${base}/members/${members.a1.user.id}`, { role: 'viewer' });
    expect(await assignees(own)).toEqual([
      { userId: members.a1.user.id, source: 'manual' },
      { userId: members.a2.user.id, source: 'auto' },
    ]);
  });
});
