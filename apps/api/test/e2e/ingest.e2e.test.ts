import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createApiChannel, createTestApp, ingest, resetDb, setupWorkspace } from '../helpers';

describe('POST /api/v1/ingest/:channelId', () => {
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

  it('creates a ticket, a customer and a message', async () => {
    const { workspaceId, http } = await setupWorkspace(app);
    const channel = await createApiChannel(http, workspaceId);

    const response = await ingest(app, channel, {
      customer: { name: 'Иван', identities: { email: 'Ivan@Example.com', phone: '+7 (999) 111-22-33' } },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ ticket_number: 1, duplicate: false, rejected_fields: [] });

    const ticket = await prisma.ticket.findUniqueOrThrow({
      where: { id: response.json().ticket_id },
      include: { customer: { include: { identities: true } }, messages: true, participants: true, events: true },
    });
    expect(ticket).toMatchObject({ subject: 'Не начислили баллы', status: 'new', revision: 1, channelId: channel.id });
    expect(ticket.customer?.identities.map((i) => [i.type, i.value]).sort()).toEqual([
      ['email', 'ivan@example.com'],
      ['phone', '79991112233'],
    ]);
    expect(ticket.messages[0]).toMatchObject({ authorType: 'customer', visibility: 'public', source: 'api' });
    expect(ticket.participants).toEqual([expect.objectContaining({ email: 'ivan@example.com', role: 'customer' })]);
    expect(ticket.events.map((e) => e.type)).toEqual(['ticket_created']);
  });

  it('a repeat with the same external_id creates nothing', async () => {
    const { workspaceId, http } = await setupWorkspace(app);
    const channel = await createApiChannel(http, workspaceId);

    const first = await ingest(app, channel, { external_id: 'req-1' });
    const second = await ingest(app, channel, { external_id: 'req-1', body: 'другой текст' });

    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ duplicate: true, ticket_id: first.json().ticket_id, message_id: first.json().message_id });
    expect(await prisma.message.count()).toBe(1);
  });

  it('conversation_external_id appends to the same ticket and reopens a resolved one', async () => {
    const { workspaceId, http } = await setupWorkspace(app);
    const channel = await createApiChannel(http, workspaceId);
    const first = await ingest(app, channel, { conversation_external_id: 'chat-7' });
    await prisma.ticket.update({ where: { id: first.json().ticket_id }, data: { status: 'resolved', resolvedAt: new Date() } });

    const second = await ingest(app, channel, { conversation_external_id: 'chat-7', body: 'Всё ещё нет баллов' });

    expect(second.json().ticket_id).toBe(first.json().ticket_id);
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: first.json().ticket_id }, include: { events: true } });
    expect(ticket).toMatchObject({ status: 'open', revision: 2, resolvedAt: null });
    expect(ticket.events.map((e) => e.type)).toContain('status_changed');
  });

  it('sent_at dates the ticket, the message and the creation event; a time in the future is replaced with now', async () => {
    const { workspaceId, http } = await setupWorkspace(app);
    const channel = await createApiChannel(http, workspaceId);

    const past = await ingest(app, channel, { external_id: 'old-1', sent_at: '2026-08-14T09:30:00+03:00' });
    const future = await ingest(app, channel, { external_id: 'new-1', sent_at: '2999-01-01T00:00:00Z' });
    const invalid = await ingest(app, channel, { external_id: 'bad-1', sent_at: 'вчера' });

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: past.json().ticket_id }, include: { messages: true, events: true } });
    const at = new Date('2026-08-14T06:30:00Z');
    expect(ticket.createdAt).toEqual(at);
    expect(ticket.lastMessageAt).toEqual(at);
    expect(ticket.messages[0]!.createdAt).toEqual(at);
    expect(ticket.events[0]).toMatchObject({ type: 'ticket_created', createdAt: at });
    // The database itself holds the same absolute time, not shifted by the Postgres server time zone.
    const [stored] = await prisma.$queryRaw<Array<{ utc: string }>>`
      SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') AS utc FROM tickets WHERE id = ${ticket.id}`;
    expect(stored!.utc).toBe('2026-08-14T06:30');

    const fresh = await prisma.message.findUniqueOrThrow({ where: { id: future.json().message_id } });
    expect(fresh.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(invalid.statusCode).toBe(422);
  });

  it('recognizes the customer by any identity and adds new ones', async () => {
    const { workspaceId, http } = await setupWorkspace(app);
    const channel = await createApiChannel(http, workspaceId);

    const first = await ingest(app, channel, { customer: { identities: { phone: '89991112233' } } });
    const second = await ingest(app, channel, { customer: { name: 'Пётр', identities: { phone: '8 999 111-22-33', employee_id: 'E-15' } } });

    const tickets = await prisma.ticket.findMany({ where: { id: { in: [first.json().ticket_id, second.json().ticket_id] } } });
    expect(new Set(tickets.map((t) => t.customerId)).size).toBe(1);
    const customer = await prisma.customer.findFirstOrThrow({ include: { identities: true } });
    expect(customer.name).toBe('Пётр');
    expect(customer.identities.map((i) => i.type).sort()).toEqual(['employee_id', 'phone']);
  });

  it('stores valid fields with their origin, drops invalid ones; metadata mapping', async () => {
    const { workspaceId, http } = await setupWorkspace(app);
    await http.post(`/workspaces/${workspaceId}/fields`, {
      entity: 'ticket',
      key: 'category',
      label: 'Категория',
      type: 'select',
      options: [
        { value: 'bonus', label: 'Бонусы' },
        { value: 'app', label: 'Приложение' },
      ],
    });
    await http.post(`/workspaces/${workspaceId}/fields`, { entity: 'ticket', key: 'dept_number', label: 'Отдел', type: 'number' });
    await http.post(`/workspaces/${workspaceId}/fields`, { entity: 'customer', key: 'tier', label: 'Уровень', type: 'text' });
    const channel = await createApiChannel(http, workspaceId, { metadataMapping: { 'form.category': 'category' } });

    const response = await ingest(app, channel, {
      metadata: { form: { category: 'bonus' } },
      fields: { dept_number: 'abc', unknown_field: 1 },
      customer: { identities: { email: 'a@example.com' }, fields: { tier: 'gold' } },
    });

    expect(response.json().rejected_fields.map((r: { key: string }) => r.key).sort()).toEqual(['dept_number', 'unknown_field']);
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: response.json().ticket_id }, include: { events: true, customer: true } });
    expect(ticket.fields).toEqual({ category: 'bonus' });
    expect(ticket.fieldMeta).toMatchObject({ category: { source: 'ingest', locked: false } });
    expect(ticket.customer?.fields).toEqual({ tier: 'gold' });
    expect(ticket.events.map((e) => e.type)).toEqual(expect.arrayContaining(['field_changed', 'fields_rejected']));
  });

  it('a wrong key — 401, a disabled channel — 403, an invalid body — 422', async () => {
    const { workspaceId, http } = await setupWorkspace(app);
    const channel = await createApiChannel(http, workspaceId);

    const wrongKey = await ingest(app, { ...channel, apiKey: 'ask_wrong' });
    const invalid = await ingest(app, channel, { body: '' });
    await http.patch(`/workspaces/${workspaceId}/channels/${channel.id}`, { enabled: false });
    const disabled = await ingest(app, channel);

    expect(wrongKey.statusCode).toBe(401);
    expect(invalid.statusCode).toBe(422);
    expect(disabled.statusCode).toBe(403);
  });
});
