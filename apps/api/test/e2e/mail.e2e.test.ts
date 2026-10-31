import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../../src/generated/prisma/client';
import { MAIL_QUEUE, pollSchedulerId } from '../../src/mail/mail.constants';
import { PrismaService } from '../../src/prisma/prisma.service';
import { bounceEml, eml } from '../fixtures/mail';
import { createApiChannel, createMailbox, createTestApp, ingest, resetDb, setupWorkspace } from '../helpers';
import { createWorkerHarness, type WorkerHarness } from '../worker-harness';

describe('mail: receiving and threading', () => {
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
    worker.mailbox.messages = [];
    worker.mailbox.uidValidity = '1';
  });

  afterAll(async () => {
    await worker.context.close();
    await app.close();
  });

  async function setup() {
    const ctx = await setupWorkspace(app);
    const mailboxId = await createMailbox(ctx.http, ctx.workspaceId, {
      imap: { host: 'imap.example.com', port: 993, user: 'support@example.com', password: 'imap-pass' },
    });
    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: mailboxId } });
    return { ...ctx, channel };
  }

  const receive = async (channel: Channel, raw: string) => worker.mailIngest.ingest(channel, raw);

  it('a new email creates a ticket: customer, participants, text without the quote, safe HTML', async () => {
    const { channel } = await setup();

    const result = await receive(
      channel,
      await eml({
        cc: ['boss@client.example', 'support@example.com'],
        text: 'Принтер не печатает.\n\nВ пятницу, 30 октября, Поддержка пишет:\n> Здравствуйте!\n> Чем помочь?',
        html: '<p>Принтер не печатает.</p><img src="https://track.example/p.gif"><script>alert(1)</script>',
      }),
    );

    expect(result.status).toBe('created');
    const ticket = await prisma.ticket.findFirstOrThrow({
      include: { messages: true, participants: true, customer: { include: { identities: true } } },
    });
    expect(ticket).toMatchObject({ subject: 'Не печатает принтер', channelId: channel.id, status: 'new' });
    expect(ticket.customer).toMatchObject({ name: 'Иван Петров', identities: [expect.objectContaining({ type: 'email', value: 'ivan@client.example' })] });
    expect(ticket.participants.map((p) => [p.email, p.role]).sort()).toEqual([
      ['boss@client.example', 'cc'],
      ['ivan@client.example', 'customer'],
    ]);
    const message = ticket.messages[0]!;
    expect(message).toMatchObject({ source: 'email', fromEmail: 'ivan@client.example', bodyClean: 'Принтер не печатает.' });
    expect(message.bodyHtml).toContain('data-blocked-src');
    expect(message.bodyHtml).not.toContain('script');
  });

  it('a customer reply to our email lands in the same ticket and reopens it', async () => {
    const { channel, http, workspaceId } = await setup();
    await receive(channel, await eml({}));
    const ticket = await prisma.ticket.findFirstOrThrow();
    const reply = (await http.post(`/workspaces/${workspaceId}/tickets/${ticket.id}/replies`, { bodyHtml: '<p>Пришлите фото ошибки</p>', via: ['email'] })).json();
    await worker.runner.run(reply.deliveries[0].id, { finalAttempt: false });
    const ours = await prisma.message.findUniqueOrThrow({ where: { id: reply.id } });

    const result = await receive(
      channel,
      await eml({ subject: 'Re: Не печатает принтер', inReplyTo: ours.rfcMessageId!, references: [ours.rfcMessageId!], text: 'Фото во вложении' }),
    );

    expect(result).toMatchObject({ status: 'appended', ticketId: ticket.id });
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).toMatchObject({ status: 'open' });
    expect(worker.sent[0]!.raw).toMatch(/In-Reply-To: <msg-/i);
  });

  it('a ticket from an API form: an email reply and the customer\'s answer come back to the same ticket', async () => {
    const { channel: mailbox, http, workspaceId } = await setup();
    const apiChannel = await createApiChannel(http, workspaceId);
    const created = (await ingest(app, apiChannel, { customer: { name: 'Иван', identities: { email: 'ivan@client.example' } } })).json();

    const reply = (await http.post(`/workspaces/${workspaceId}/tickets/${created.ticket_id}/replies`, { bodyHtml: '<p>Уточните номер чека</p>', via: ['email'] })).json();
    expect(reply.subject).toBe(`Re: Не начислили баллы [#T-${created.ticket_number}]`);
    await worker.runner.run(reply.deliveries[0].id, { finalAttempt: false });
    const ours = await prisma.message.findUniqueOrThrow({ where: { id: reply.id } });

    const result = await receive(mailbox, await eml({ subject: reply.subject, inReplyTo: ours.rfcMessageId!, text: 'Чек 000123' }));

    expect(result).toMatchObject({ status: 'appended', ticketId: created.ticket_id });
  });

  it('the [#T-n] token in the subject joins an email without headers, but only from a participant', async () => {
    const { channel } = await setup();
    await receive(channel, await eml({}));
    const ticket = await prisma.ticket.findFirstOrThrow();

    const fromParticipant = await receive(channel, await eml({ subject: `Re: Принтер [#T-${ticket.number}]`, text: 'Ещё не работает' }));
    const fromStranger = await receive(
      channel,
      await eml({ from: 'Чужой <stranger@other.example>', subject: `Re: Принтер [#T-${ticket.number}]`, text: 'Спам' }),
    );

    expect(fromParticipant).toMatchObject({ status: 'appended', ticketId: ticket.id });
    expect(fromStranger.status).toBe('created');
  });

  it('an auto-reply in a thread does not reopen the ticket, outside a thread it is ignored', async () => {
    const { channel } = await setup();
    const first = await eml({});
    await receive(channel, first);
    const ticket = await prisma.ticket.findFirstOrThrow({ include: { messages: true } });
    await prisma.ticket.update({ where: { id: ticket.id }, data: { status: 'pending' } });

    const inThread = await receive(
      channel,
      await eml({ subject: 'Автоответ: в отпуске', inReplyTo: ticket.messages[0]!.rfcMessageId!, headers: { 'Auto-Submitted': 'auto-replied' } }),
    );
    const outside = await receive(channel, await eml({ subject: 'Out of office', headers: { 'Auto-Submitted': 'auto-replied' } }));

    expect(inThread.status).toBe('appended');
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).toMatchObject({ status: 'pending', revision: 1 });
    expect(await prisma.message.count({ where: { isAutomated: true } })).toBe(1);
    expect(outside).toEqual({ status: 'ignored', reason: 'automated (auto_reply) without thread' });
  });

  it('a bounce marks our email as undelivered', async () => {
    const { channel, http, workspaceId } = await setup();
    await receive(channel, await eml({}));
    const ticket = await prisma.ticket.findFirstOrThrow();
    const reply = (await http.post(`/workspaces/${workspaceId}/tickets/${ticket.id}/replies`, { bodyHtml: '<p>Ответ</p>', via: ['email'] })).json();
    await worker.runner.run(reply.deliveries[0].id, { finalAttempt: false });
    const ours = await prisma.message.findUniqueOrThrow({ where: { id: reply.id } });

    const result = await receive(channel, bounceEml(ours.rfcMessageId!));

    expect(result).toEqual({ status: 'bounce', ticketId: ticket.id });
    expect(await prisma.delivery.findFirstOrThrow({ where: { messageId: reply.id } })).toMatchObject({
      status: 'failed',
      lastError: 'Bounced: smtp; 550 5.1.1 User unknown',
    });
    expect(await prisma.ticketEvent.count({ where: { ticketId: ticket.id, type: 'delivery_bounced' } })).toBe(1);
  });

  it('a duplicate by Message-ID and our own emails create no messages', async () => {
    const { channel } = await setup();
    const raw = await eml({});

    await receive(channel, raw);
    const duplicate = await receive(channel, raw);
    const own = await receive(channel, await eml({ from: 'support@example.com', to: 'ivan@client.example' }));

    expect(duplicate.status).toBe('duplicate');
    expect(own).toEqual({ status: 'ignored', reason: 'own message' });
    expect(await prisma.message.count()).toBe(1);
  });

  it('attachments are stored and downloadable', async () => {
    const { channel, http, workspaceId } = await setup();

    await receive(channel, await eml({ attachments: [{ filename: 'ошибка.txt', content: 'Error 0x51' }] }));

    const attachment = await prisma.attachment.findFirstOrThrow();
    expect(attachment).toMatchObject({ filename: 'ошибка.txt', size: 10 });
    const download = await http.get(`/workspaces/${workspaceId}/attachments/${attachment.id}`);
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe('Error 0x51');
    expect(download.headers['content-disposition']).toContain(encodeURIComponent('ошибка.txt'));
  });

  it('an email to a long-closed ticket creates a new one', async () => {
    const { channel } = await setup();
    await receive(channel, await eml({}));
    const ticket = await prisma.ticket.findFirstOrThrow({ include: { messages: true } });
    await prisma.ticket.update({
      where: { id: ticket.id },
      data: { status: 'closed', resolvedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) },
    });

    const result = await receive(channel, await eml({ inReplyTo: ticket.messages[0]!.rfcMessageId!, text: 'Снова сломался' }));

    expect(result.status).toBe('created');
  });

  describe('IMAP poller', () => {
    it('without importExisting starts with new emails and moves the cursor', async () => {
      const { channel } = await setup();
      worker.mailbox.add(await eml({ subject: 'Старое письмо' }));

      expect(await worker.poller.poll(channel.id)).toEqual({ imported: 0, skipped: 0, error: null });
      worker.mailbox.add(await eml({ subject: 'Новое письмо' }));
      expect(await worker.poller.poll(channel.id)).toEqual({ imported: 1, skipped: 0, error: null });
      expect(await worker.poller.poll(channel.id)).toEqual({ imported: 0, skipped: 0, error: null });

      expect((await prisma.ticket.findMany()).map((t) => t.subject)).toEqual(['Новое письмо']);
      expect(await prisma.channel.findUniqueOrThrow({ where: { id: channel.id } })).toMatchObject({
        syncState: { uidValidity: '1', lastUid: 2 },
        lastSyncError: null,
      });
    });

    it('with importExisting takes old emails too; a UIDVALIDITY change resets the cursor', async () => {
      const { channel, http, workspaceId } = await setup();
      await http.patch(`/workspaces/${workspaceId}/channels/${channel.id}`, {
        imap: { host: 'imap.example.com', port: 993, user: 'support@example.com', importExisting: true },
      });
      worker.mailbox.add(await eml({ subject: 'Письмо 1' }));
      worker.mailbox.add(await eml({ subject: 'Письмо 2' }));

      expect((await worker.poller.poll(channel.id))?.imported).toBe(2);

      worker.mailbox.uidValidity = '2';
      worker.mailbox.messages = [];
      worker.mailbox.add(await eml({ subject: 'После переиндексации' }));
      expect((await worker.poller.poll(channel.id))?.imported).toBe(1);
      expect(await prisma.ticket.count()).toBe(3);
    });

    it('a broken email is skipped after three failures, the rest are imported', async () => {
      const { channel } = await setup();
      await worker.poller.poll(channel.id);
      worker.mailbox.add(await eml({ subject: 'Хорошее 1' }));
      worker.mailbox.add('BROKEN');
      const original = worker.mailIngest.ingest.bind(worker.mailIngest);
      const spy = vi.spyOn(worker.mailIngest, 'ingest').mockImplementation(async (ch, raw) => {
        if (raw.toString() === 'BROKEN') throw new Error('parser exploded');
        return original(ch, raw);
      });
      worker.mailbox.add(await eml({ subject: 'Хорошее 2' }));

      const results = [];
      for (let i = 0; i < 3; i += 1) {
        results.push(await worker.poller.poll(channel.id));
      }

      spy.mockRestore();
      expect(results.map((r) => r?.imported)).toEqual([1, 0, 1]);
      expect(results[0]?.error).toBe('parser exploded');
      expect(results[2]?.skipped).toBe(1);
      expect((await prisma.channel.findUniqueOrThrow({ where: { id: channel.id } })).lastSyncError).toMatch(/UID 2 skipped/);
    });

    it('configuring a channel with IMAP sets up the polling schedule', async () => {
      const { channel } = await setup();
      const queue = app.get<Queue>(getQueueToken(MAIL_QUEUE));

      expect(await queue.getJobScheduler(pollSchedulerId(channel.id))).toMatchObject({ every: 60_000 });
    });
  });
});
