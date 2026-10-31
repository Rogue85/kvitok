import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Queue } from 'bullmq';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OUTBOUND_QUEUE } from '../../src/outbound/outbound.constants';
import type { DeliveryRunner } from '../../src/outbound/delivery-runner';
import { signWebhook } from '../../src/outbound/webhook-sender';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createApiChannel, createMailbox, createTestApp, ingest, resetDb, setupWorkspace } from '../helpers';
import { createWorkerHarness, type SentMail } from '../worker-harness';

describe('conversation: notes and replies', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let worker: INestApplicationContext;
  let runner: DeliveryRunner;
  let sent: SentMail[];
  let failNext: (error: Error) => void;
  let hookServer: Server;
  let hookUrl: string;
  let hookRequests: Array<{ headers: IncomingHttpHeaders; body: string }>;
  let hookStatus = 200;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    const harness = await createWorkerHarness();
    ({ context: worker, runner, sent, failNext } = harness);

    hookServer = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        hookRequests.push({ headers: req.headers, body });
        res.statusCode = hookStatus;
        res.end();
      });
    });
    await new Promise<void>((resolve) => hookServer.listen(0, '127.0.0.1', resolve));
    hookUrl = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}/hook`;
  });

  beforeEach(async () => {
    await resetDb(app);
    sent.length = 0;
    hookRequests = [];
    hookStatus = 200;
  });

  afterAll(async () => {
    hookServer.close();
    await worker.close();
    await app.close();
  });

  async function setup(options: { mailbox?: boolean } = {}) {
    const ctx = await setupWorkspace(app);
    const channel = await createApiChannel(ctx.http, ctx.workspaceId, { webhookUrl: hookUrl });
    const mailboxId = options.mailbox === false ? null : await createMailbox(ctx.http, ctx.workspaceId);
    const ticket = (await ingest(app, channel)).json();
    const base = `/workspaces/${ctx.workspaceId}/tickets/${ticket.ticket_id}`;
    return { ...ctx, channel, mailboxId, ticket, base };
  }

  it('a message to the agent is an internal message and input for the agent', async () => {
    const { http, base, ticket } = await setup();

    const note = await http.post(`${base}/agent/messages`, { body: 'Позвонил гостю,\nчек на 540 ₽' });

    expect(note.statusCode).toBe(201);
    expect(note.json()).toMatchObject({ visibility: 'internal', authorType: 'operator', bodyHtml: '<p>Позвонил гостю,<br>чек на 540 ₽</p>' });
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.ticket_id } })).revision).toBe(2);
  });

  it('an email reply: the email is queued with an undo delay, then goes out with thread headers', async () => {
    const { http, base, ticket } = await setup();

    const reply = await http.post(`${base}/replies`, { bodyHtml: '<p>Добрый день! <script>x</script>Баллы начислены.</p>', via: ['email'] });

    expect(reply.statusCode).toBe(201);
    const message = reply.json();
    expect(message).toMatchObject({
      visibility: 'public',
      subject: `Re: Не начислили баллы [#T-${ticket.ticket_number}]`,
      to: ['ivan@example.com'],
      fromEmail: 'support@example.com',
      deliveries: [{ kind: 'email', status: 'queued' }],
    });
    expect(message.bodyHtml).not.toContain('script');
    expect(message.bodyHtml).toContain('Команда поддержки');

    const delivery = await prisma.delivery.findFirstOrThrow({ where: { messageId: message.id } });
    expect(delivery.scheduledAt.getTime() - Date.now()).toBeGreaterThan(8_000);
    const job = await app.get<Queue>(getQueueToken(OUTBOUND_QUEUE)).getJob(delivery.id);
    expect(job?.opts.delay).toBeGreaterThan(8_000);

    const updated = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.ticket_id } });
    expect(updated).toMatchObject({ status: 'pending', revision: 2 });
    expect(updated.firstResponseAt).not.toBeNull();

    await expect(runner.run(delivery.id, { finalAttempt: false })).resolves.toBe('sent');
    expect(sent).toHaveLength(1);
    const raw = sent[0]!.raw;
    expect(raw).toMatch(new RegExp(`Message-ID: <t${ticket.ticket_number}\\.${message.id}@example\\.com>`, 'i'));
    expect(raw).toMatch(/Reply-To: support@example\.com/i);
    expect(raw).toMatch(/To: ivan@example\.com/i);
    expect(await prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({ status: 'sent', attempts: 1 });

    await expect(runner.run(delivery.id, { finalAttempt: false })).resolves.toBe('skipped');
  });

  it('without a mailbox an email reply is impossible', async () => {
    const { http, base } = await setup({ mailbox: false });

    const reply = await http.post(`${base}/replies`, { bodyHtml: '<p>Ok</p>', via: ['email'] });

    expect(reply.statusCode).toBe(422);
  });

  it('if the customer wrote while the operator was replying — 409, with force it is sent', async () => {
    const { http, base, channel, ticket } = await setup();
    const timeline = (await http.get(`${base}/timeline`)).json();
    const lastSeen = timeline.filter((i: { kind: string }) => i.kind === 'message').at(-1).message.id;
    await ingest(app, channel, { conversation_external_id: undefined, external_id: 'late-1' });
    await prisma.message.updateMany({ where: { externalId: 'late-1' }, data: { ticketId: ticket.ticket_id } });

    const stale = await http.post(`${base}/replies`, { bodyHtml: '<p>Ok</p>', via: ['email'], lastSeenMessageId: lastSeen });
    const forced = await http.post(`${base}/replies`, { bodyHtml: '<p>Ok</p>', via: ['email'], lastSeenMessageId: lastSeen, force: true });

    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('stale_conversation');
    expect(forced.statusCode).toBe(201);
  });

  it('cancelling sending: the delivery is cancelled and does not go out; after sending — too_late', async () => {
    const { http, base } = await setup();
    const queue = app.get<Queue>(getQueueToken(OUTBOUND_QUEUE));

    const first = (await http.post(`${base}/replies`, { bodyHtml: '<p>Ой</p>', via: ['email'] })).json();
    const cancelled = await http.post(`${base}/messages/${first.id}/cancel`);
    const delivery = await prisma.delivery.findFirstOrThrow({ where: { messageId: first.id } });

    expect(cancelled.statusCode).toBe(201);
    expect(cancelled.json().deliveries).toEqual([expect.objectContaining({ status: 'cancelled' })]);
    expect(await queue.getJob(delivery.id)).toBeUndefined();
    await expect(runner.run(delivery.id, { finalAttempt: false })).resolves.toBe('skipped');
    expect(sent).toHaveLength(0);

    const second = (await http.post(`${base}/replies`, { bodyHtml: '<p>Ok</p>', via: ['email'] })).json();
    await runner.run(second.deliveries[0].id, { finalAttempt: false });
    const tooLate = await http.post(`${base}/messages/${second.id}/cancel`);
    expect(tooLate.statusCode).toBe(409);
    expect(tooLate.json().error.code).toBe('too_late');
  });

  it('a reply to the source: a signed webhook', async () => {
    const { http, base, channel, ticket } = await setup({ mailbox: false });

    const reply = (await http.post(`${base}/replies`, { bodyHtml: '<p>Баллы начислены</p>', via: ['source'], statusAfter: 'resolved' })).json();
    await runner.run(reply.deliveries[0].id, { finalAttempt: false });

    expect(hookRequests).toHaveLength(1);
    const request = hookRequests[0]!;
    expect(request.headers['x-support-event']).toBe('message.created');
    expect(request.headers['x-support-signature']).toBe(
      signWebhook(channel.webhookSecret!, String(request.headers['x-support-timestamp']), request.body),
    );
    expect(JSON.parse(request.body)).toMatchObject({
      event: 'message.created',
      ticket: { id: ticket.ticket_id, status: 'resolved' },
      message: { id: reply.id, body_text: 'Баллы начислены' },
    });
  });

  it('a delivery error: retries, on the last attempt — failed and an event in the ticket', async () => {
    const { http, base, ticket } = await setup();
    const reply = (await http.post(`${base}/replies`, { bodyHtml: '<p>Ok</p>', via: ['email', 'source'] })).json();
    const email = reply.deliveries.find((d: { kind: string }) => d.kind === 'email');
    const webhook = reply.deliveries.find((d: { kind: string }) => d.kind === 'webhook');

    failNext(new Error('SMTP 421 try later'));
    await expect(runner.run(email.id, { finalAttempt: false })).rejects.toThrow('SMTP 421');
    expect(await prisma.delivery.findUniqueOrThrow({ where: { id: email.id } })).toMatchObject({ status: 'queued', lastError: 'SMTP 421 try later' });
    await expect(runner.run(email.id, { finalAttempt: false })).resolves.toBe('sent');

    hookStatus = 500;
    await expect(runner.run(webhook.id, { finalAttempt: true })).rejects.toThrow('HTTP 500');
    expect(await prisma.delivery.findUniqueOrThrow({ where: { id: webhook.id } })).toMatchObject({ status: 'failed', responseStatus: 500 });
    const events = await prisma.ticketEvent.findMany({ where: { ticketId: ticket.ticket_id, type: 'delivery_failed' } });
    expect(events).toHaveLength(1);
  });

  it('a reply cannot resolve the ticket without the required fields', async () => {
    const { workspaceId, http, base } = await setup();
    await http.post(`/workspaces/${workspaceId}/fields`, { entity: 'ticket', key: 'resolution', label: 'Решение', type: 'text', requiredOn: ['resolve'] });

    const reply = await http.post(`${base}/replies`, { bodyHtml: '<p>Ok</p>', via: ['email'], statusAfter: 'resolved' });

    expect(reply.statusCode).toBe(422);
    expect(await prisma.message.count({ where: { authorType: 'operator' } })).toBe(0);
  });
});
