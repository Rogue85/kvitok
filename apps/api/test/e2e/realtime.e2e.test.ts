import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RealtimeService } from '../../src/realtime/realtime.service';
import { client, createApiChannel, createTestApp, createUser, createWorkspace, ingest, login, resetDb } from '../helpers';

describe('SSE /workspaces/:id/events', () => {
  let app: NestFastifyApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    await resetDb(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('sends events of its own workspace and not of others', async () => {
    const user = await createUser(app);
    const workspaceId = await createWorkspace(app, [{ user, role: 'admin' }]);
    const otherWorkspaceId = await createWorkspace(app, [{ user, role: 'admin' }]);
    const http = client(app, await login(app, user));
    const ownChannel = await createApiChannel(http, workspaceId);
    const otherChannel = await createApiChannel(http, otherWorkspaceId);
    await app.get(RealtimeService).ready();

    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/events`, {
      headers: { cookie: await login(app, user) },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const other = (await ingest(app, otherChannel)).json();
    const own = (await ingest(app, ownChannel)).json();

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const deadline = Date.now() + 5_000;
    while (!text.includes(own.ticket_id) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    controller.abort();

    expect(text).toContain('event: ticket.created');
    expect(text).toContain(`"ticketId":"${own.ticket_id}"`);
    expect(text).not.toContain(other.ticket_id);
  });

  it('sends events of tickets in the member departments, and moves in and out of them', async () => {
    const admin = await createUser(app);
    const workspaceId = await createWorkspace(app, [{ user: admin, role: 'admin' }]);
    const http = client(app, await login(app, admin));
    const base = `/workspaces/${workspaceId}`;
    const a = (await http.post(`${base}/departments`, { key: 'a', title: 'A' })).json();
    const b = (await http.post(`${base}/departments`, { key: 'b', title: 'B' })).json();
    const operator = await createUser(app);
    await http.post(`${base}/members`, { userId: operator.id, role: 'operator', departments: { allDepartments: false, departmentIds: [a.id] } });
    const channel = await createApiChannel(http, workspaceId);
    const ownTicket = (await ingest(app, channel)).json().ticket_id as string;
    const otherTicket = (await ingest(app, channel)).json().ticket_id as string;
    await http.patch(`${base}/tickets/${ownTicket}`, { departmentId: a.id });
    await http.patch(`${base}/tickets/${otherTicket}`, { departmentId: b.id });
    await app.get(RealtimeService).ready();

    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api${base}/events`, { headers: { cookie: await login(app, operator) }, signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (marker: string) => {
      const deadline = Date.now() + 5_000;
      while (!text.includes(marker) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    };

    await http.patch(`${base}/tickets/${otherTicket}`, { priority: 'high' });
    await http.patch(`${base}/tickets/${ownTicket}`, { priority: 'high', tags: ['first'] });
    await readUntil(`"ticketId":"${ownTicket}"`);
    // The ticket arrives in the member's department, then the own one leaves it.
    await http.patch(`${base}/tickets/${otherTicket}`, { departmentId: a.id });
    await readUntil(`"to":"${a.id}"`);
    await http.patch(`${base}/tickets/${ownTicket}`, { departmentId: b.id });
    await readUntil(`"to":"${b.id}"`);
    await http.patch(`${base}/tickets/${ownTicket}`, { tags: ['after'] });
    await http.patch(`${base}/members/${operator.id}`, { departments: { allDepartments: false, departmentIds: [b.id] } });
    await readUntil('event: access.changed');
    controller.abort();

    const events = text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice('data: '.length)) as { type: string; ticketId?: string })
      .filter((event) => event.type !== 'ping');
    expect(events).toEqual([
      { type: 'ticket.updated', ticketId: ownTicket },
      { type: 'ticket.moved', ticketId: otherTicket, from: b.id, to: a.id },
      { type: 'ticket.updated', ticketId: otherTicket },
      { type: 'ticket.moved', ticketId: ownTicket, from: a.id, to: b.id },
      { type: 'access.changed', userId: operator.id },
    ]);
  });

  it('without a session — 401', async () => {
    const response = await fetch(`${baseUrl}/api/workspaces/x/events`);
    expect(response.status).toBe(401);
  });
});
