import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { client, createApiChannel, createMailbox, createTestApp, createUser, createWorkspace, ingest, login, resetDb } from '../helpers';
import { createWorkerHarness, type WorkerHarness } from '../worker-harness';

describe('test mailbox', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let worker: WorkerHarness;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    worker = await createWorkerHarness();
  });

  beforeEach(async () => {
    await resetDb(app);
    worker.sent.length = 0;
  });

  afterAll(async () => {
    await worker.context.close();
    await app.close();
  });

  /** The default mailbox is a test one; a ticket from the API, the customer has only a phone (as in the simulator). */
  async function setup() {
    const admin = await createUser(app);
    const viewer = await createUser(app);
    const workspaceId = await createWorkspace(app, [
      { user: admin, role: 'admin' },
      { user: viewer, role: 'viewer' },
    ]);
    const http = client(app, await login(app, admin));
    const mailboxId = await createMailbox(http, workspaceId, { name: 'Тестовый', address: 'test@support.local', transport: 'sandbox', smtp: null });
    const apiChannel = await createApiChannel(http, workspaceId);
    const created = (await ingest(app, apiChannel, { customer: { name: 'Егор', identities: { phone: '79000000006' } } })).json();
    const base = `/workspaces/${workspaceId}/tickets/${created.ticket_id}`;
    const outbox = `/workspaces/${workspaceId}/channels/${mailboxId}/outbox`;
    return { workspaceId, http, viewerHttp: client(app, await login(app, viewer)), mailboxId, ticketId: created.ticket_id as string, base, outbox };
  }

  it('is created without SMTP and becomes the default mailbox; SMTP cannot be set on it', async () => {
    const { http, workspaceId, mailboxId } = await setup();

    const channel = (await http.get(`/workspaces/${workspaceId}/channels/${mailboxId}`)).json();
    expect(channel).toMatchObject({ transport: 'sandbox', smtp: null, imap: null, isDefaultMailbox: true });

    const withSmtp = await http.post(`/workspaces/${workspaceId}/channels`, {
      type: 'email',
      transport: 'sandbox',
      name: 'X',
      address: 'x@support.local',
      smtp: { host: 'smtp.example.com', port: 465, user: 'x', password: 'p' },
    });
    expect(withSmtp.statusCode).toBe(422);
    const patchSmtp = await http.patch(`/workspaces/${workspaceId}/channels/${mailboxId}`, { smtp: { host: 'smtp.example.com', port: 465, user: 'x', password: 'p' } });
    expect(patchSmtp.statusCode).toBe(422);
    const realWithoutSmtp = await http.post(`/workspaces/${workspaceId}/channels`, { type: 'email', name: 'Y', address: 'y@example.com' });
    expect(realWithoutSmtp.statusCode).toBe(422);

    const check = (await http.post(`/workspaces/${workspaceId}/channels/${mailboxId}/test`)).json();
    expect(check).toEqual({ smtp: { ok: true }, imap: null });
  });

  it('a reply to the customer does not go to the transport but lands in the Outbox with recipients, signature and headers', async () => {
    const { http, base, outbox, mailboxId } = await setup();

    const reply = (
      await http.post(`${base}/replies`, { bodyHtml: '<p>Купон начислим сегодня</p>', via: ['email'], to: ['egor@client.example'], cc: ['boss@client.example'] })
    ).json();
    await expect(worker.runner.run(reply.deliveries[0].id, { finalAttempt: false })).resolves.toBe('sent');

    expect(worker.sent).toHaveLength(0);
    const list = (await http.get(outbox)).json();
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({
      to: ['egor@client.example'],
      cc: ['boss@client.example'],
      from: { address: 'test@support.local', name: 'Поддержка Example' },
      subject: reply.subject,
      deliveryId: reply.deliveries[0].id,
      attachmentCount: 0,
    });

    const email = (await http.get(`${outbox}/${list.items[0].id}`)).json();
    expect(email.html).toContain('Купон начислим сегодня');
    expect(email.html).toContain('Команда поддержки');
    const ours = await prisma.message.findUniqueOrThrow({ where: { id: reply.id } });
    expect(email.messageId).toBe(ours.rfcMessageId);
    expect(email.headers).toEqual(
      expect.arrayContaining([
        { key: 'to', value: 'egor@client.example' },
        { key: 'subject', value: reply.subject },
        { key: 'from', value: '"Поддержка Example" <test@support.local>' },
      ]),
    );

    const raw = await http.get(`${outbox}/${email.id}/raw`);
    expect(raw.headers['content-type']).toBe('message/rfc822');
    expect(raw.body).toMatch(/^Cc: boss@client\.example/m);

    const delivery = await prisma.delivery.findUniqueOrThrow({ where: { id: reply.deliveries[0].id } });
    expect(delivery).toMatchObject({ status: 'sent', providerMessageId: ours.rfcMessageId });
    // An address entered for a ticket without email is remembered as the customer's address — the next reply goes there too.
    const ticket = (await http.get(base)).json();
    expect(ticket.participants).toEqual(
      expect.arrayContaining([
        { email: 'egor@client.example', name: null, role: 'customer' },
        { email: 'boss@client.example', name: null, role: 'cc' },
      ]),
    );
    const timeline = (await http.get(`${base}/timeline`)).json();
    const message = timeline.find((item: { kind: string; message?: { id: string } }) => item.message?.id === reply.id).message;
    expect(message.deliveries[0].sandboxEmail).toEqual({ id: email.id, channelId: mailboxId });
  });

  it('a delivery retry does not duplicate the email, a cancelled delivery creates no email', async () => {
    const { http, base, outbox } = await setup();

    const reply = (await http.post(`${base}/replies`, { bodyHtml: '<p>Раз</p>', via: ['email'], to: ['egor@client.example'] })).json();
    await worker.runner.run(reply.deliveries[0].id, { finalAttempt: false });
    // The worker crashed after writing the email but before marking it sent — BullMQ retries the delivery.
    await prisma.delivery.update({ where: { id: reply.deliveries[0].id }, data: { status: 'sending' } });
    await worker.runner.run(reply.deliveries[0].id, { finalAttempt: false });

    const cancelled = (await http.post(`${base}/replies`, { bodyHtml: '<p>Ой</p>', via: ['email'], to: ['egor@client.example'] })).json();
    await http.post(`${base}/messages/${cancelled.id}/cancel`);
    await worker.runner.run(cancelled.deliveries[0].id, { finalAttempt: false });

    expect((await http.get(outbox)).json().total).toBe(1);
  });

  it('search by part of an address, permissions and clearing', async () => {
    const { http, viewerHttp, base, outbox, workspaceId } = await setup();
    for (const to of ['egor@client.example', 'anna@other.example']) {
      const reply = (await http.post(`${base}/replies`, { bodyHtml: '<p>Ответ</p>', via: ['email'], to: [to], force: true })).json();
      await worker.runner.run(reply.deliveries[0].id, { finalAttempt: false });
    }

    const found = (await viewerHttp.get(`${outbox}?address=OTHER.ex`)).json();
    expect(found.items.map((e: { to: string[] }) => e.to)).toEqual([['anna@other.example']]);
    expect((await viewerHttp.get(`${outbox}?address=nobody`)).json().total).toBe(0);

    const apiChannel = await createApiChannel(http, workspaceId);
    expect((await http.get(`/workspaces/${workspaceId}/channels/${apiChannel.id}/outbox`)).statusCode).toBe(422);

    expect((await viewerHttp.delete(outbox)).statusCode).toBe(403);
    expect((await http.delete(outbox)).json()).toEqual({ deleted: 2 });
    expect((await http.get(outbox)).json().total).toBe(0);
  });
});
