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

  it('without a session — 401', async () => {
    const response = await fetch(`${baseUrl}/api/workspaces/x/events`);
    expect(response.status).toBe(401);
  });
});
