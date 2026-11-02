import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../src/common/ids';
import { NotificationDispatcher } from '../../src/notifications/notification-dispatcher';
import { AGENT_WAIT_MS, incomingJobId, NOTIFY_QUEUE, type NotifyJobData } from '../../src/notifications/notifications.constants';
import { NotificationsService } from '../../src/notifications/notifications.service';
import type { Notification, NotifierChannel } from '../../src/notifications/notifier-channel';
import { PrismaService } from '../../src/prisma/prisma.service';
import { client, createApiChannel, createUser, createTestApp, ingest, login, resetDb, setupWorkspace } from '../helpers';

/** A channel that records what it would send; reachable are users with a push subscription. */
class RecordingChannel implements NotifierChannel {
  sent: Array<{ userId: string; notification: Notification }> = [];
  constructor(private readonly prisma: PrismaService) {}
  async reachable(userIds: string[]): Promise<Set<string>> {
    const rows = await this.prisma.pushSubscription.findMany({ where: { userId: { in: userIds } } });
    return new Set(rows.map((row) => row.userId));
  }
  async deliver(userId: string, notification: Notification): Promise<void> {
    this.sent.push({ userId, notification });
  }
}

const subscription = (n: number) => ({
  endpoint: `https://push.example.com/send/${n}`,
  keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' },
});

describe('notifications', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let queue: Queue<NotifyJobData>;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    queue = app.get<Queue<NotifyJobData>>(getQueueToken(NOTIFY_QUEUE));
  });

  beforeEach(async () => {
    await resetDb(app);
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await app.close();
  });

  async function setup() {
    const admin = await setupWorkspace(app);
    const user = await createUser(app);
    await admin.http.post(`/workspaces/${admin.workspaceId}/members`, { userId: user.id, role: 'operator' });
    const operator = { user, http: client(app, await login(app, user)) };
    return { ...admin, operator };
  }

  describe('settings', () => {
    it('start with the defaults and keep what the member saves', async () => {
      const { http, workspaceId } = await setup();
      const url = `/workspaces/${workspaceId}/notification-settings`;
      const department = (await http.post(`/workspaces/${workspaceId}/departments`, { key: 'billing', title: 'Оплата' })).json();

      expect((await http.get(url)).json()).toMatchObject({ events: { ticketCreated: 'mine_unassigned', customerMessage: 'mine' }, departmentIds: null });

      const saved = await http.put(url, {
        events: { customerMessage: 'all', agentFailed: true },
        departmentIds: [department.id, 'unknown'],
        minPriority: 'high',
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({ events: { customerMessage: 'all', agentFailed: true, assigned: true }, departmentIds: [department.id], minPriority: 'high' });
      expect((await http.get(url)).json()).toEqual(saved.json());
      expect((await http.put(url, { events: { customerMessage: 'sometimes' } })).statusCode).toBe(422);
    });

    it('are per member and need a membership', async () => {
      const { http, workspaceId, operator } = await setup();
      const url = `/workspaces/${workspaceId}/notification-settings`;
      await operator.http.put(url, { events: { customerMessage: 'off' } });
      expect((await http.get(url)).json().events.customerMessage).toBe('mine');

      const superadmin = await createUser(app, { superadmin: true });
      const outsider = client(app, await login(app, superadmin));
      expect((await outsider.get(url)).statusCode).toBe(404);
    });
  });

  describe('push subscriptions', () => {
    it('belong to the session: listed as this device, gone on sign-out', async () => {
      const { http, user } = await setup();
      const other = client(app, await login(app, user));

      const config = (await http.get('/notifications/push')).json();
      expect(config.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
      expect((await other.get('/notifications/push')).json().publicKey).toBe(config.publicKey);
      expect(await prisma.installationSecret.count()).toBe(1);

      const created = await http.post('/notifications/push/subscriptions', subscription(1));
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ current: true });
      expect((await other.get('/notifications/push')).json().subscriptions).toEqual([expect.objectContaining({ id: created.json().id, current: false })]);

      // The same browser subscribing again takes the subscription over instead of adding one.
      await other.post('/notifications/push/subscriptions', subscription(1));
      expect(await prisma.pushSubscription.count()).toBe(1);

      await other.post('/auth/logout');
      expect(await prisma.pushSubscription.count()).toBe(0);
    });

    it('are removed only by their owner', async () => {
      const { http, operator } = await setup();
      const id = (await operator.http.post('/notifications/push/subscriptions', subscription(2))).json().id;
      expect((await http.delete(`/notifications/push/subscriptions/${id}`)).statusCode).toBe(204);
      expect(await prisma.pushSubscription.count()).toBe(1);
      expect((await operator.http.delete(`/notifications/push/subscriptions/${id}`)).statusCode).toBe(204);
      expect(await prisma.pushSubscription.count()).toBe(0);
    });

    it('accept only https endpoints on a domain name', async () => {
      const { http } = await setup();
      for (const endpoint of ['http://push.example.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5:8443/x', 'https://minio:9000/x']) {
        expect((await http.post('/notifications/push/subscriptions', { ...subscription(3), endpoint })).statusCode).toBe(422);
      }
      expect(await prisma.pushSubscription.count()).toBe(0);
    });
  });

  describe('delivery', () => {
    async function subscribed() {
      const context = await setup();
      await context.http.post('/notifications/push/subscriptions', subscription(1));
      await context.operator.http.post('/notifications/push/subscriptions', subscription(2));
      const channel = await createApiChannel(context.http, context.workspaceId);
      const recorder = new RecordingChannel(prisma);
      const dispatcher = new NotificationDispatcher(prisma, [recorder]);
      return { ...context, channel, recorder, dispatcher };
    }

    it('a new ticket goes to the members following unassigned tickets once the job runs', async () => {
      const { channel, recorder, dispatcher, workspaceId, operator } = await subscribed();
      await operator.http.put(`/workspaces/${workspaceId}/notification-settings`, { events: { ticketCreated: 'off' } });

      const ticketId = (await ingest(app, channel)).json().ticket_id as string;
      const job = await queue.getJob(incomingJobId(ticketId));
      // The agent is off in this workspace, so nothing to wait for.
      expect(await job?.isDelayed()).toBe(false);
      expect(job?.data).toMatchObject({ kind: 'incoming', created: true });

      expect(await dispatcher.dispatch(job!.data)).toBe(1);
      expect(recorder.sent).toEqual([
        {
          userId: expect.any(String),
          notification: {
            title: 'New ticket T-1',
            body: 'Не начислили баллы\nКупил кофе вчера, баллы не пришли',
            url: `/w/${workspaceId}/tickets/${ticketId}`,
            tag: `ticket:${ticketId}`,
            urgent: false,
          },
        },
      ]);
      expect(recorder.sent[0]!.userId).not.toBe(operator.user.id);
    });

    it('customer messages during the wait join one notification for the assignee', async () => {
      const { channel, recorder, dispatcher, http, workspaceId, operator } = await subscribed();
      const first = (await ingest(app, channel, { conversation_external_id: 'c1' })).json().ticket_id as string;
      await queue.obliterate({ force: true });
      await http.patch(`/workspaces/${workspaceId}/tickets/${first}`, { assigneeIds: [operator.user.id] });
      await queue.obliterate({ force: true });

      const service = app.get(NotificationsService);
      const second = (await ingest(app, channel, { conversation_external_id: 'c1', body: 'Ещё вопрос' })).json().message_id as string;
      await queue.obliterate({ force: true });
      await service.incoming(workspaceId, first, { messageId: second, created: false, waitForAgent: true });
      await ingest(app, channel, { conversation_external_id: 'c1', body: 'И ещё один' });

      const jobs = await queue.getJobs(['delayed', 'wait']);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.opts.delay).toBe(AGENT_WAIT_MS);

      // The agent finished: the waiting notification goes out without the rest of the delay.
      await service.agentSettled(workspaceId, first, new Date());
      expect(await jobs[0]!.isDelayed()).toBe(false);

      await dispatcher.dispatch(jobs[0]!.data);
      expect(recorder.sent).toEqual([
        { userId: operator.user.id, notification: expect.objectContaining({ title: '2 new messages in T-1', body: 'Не начислили баллы\nИ ещё один' }) },
      ]);
    });

    it('a new ticket handed out in turn while its notification waits for the agent reaches the assignee once, as assigned', async () => {
      const { channel, recorder, dispatcher, http, workspaceId, operator } = await subscribed();
      const department = (await http.post(`/workspaces/${workspaceId}/departments`, { key: 'loyalty', title: 'Лояльность', assignmentMode: 'round_robin' })).json();
      await operator.http.put(`/workspaces/${workspaceId}/members/${operator.user.id}/accepting-tickets`, { accepting: true });
      const created = (await ingest(app, channel)).json();
      await queue.obliterate({ force: true });
      const service = app.get(NotificationsService);
      await service.incoming(workspaceId, created.ticket_id, { messageId: created.message_id, created: true, waitForAgent: true });

      // The department gets the ticket during the wait, as when the agent routes it.
      await http.patch(`/workspaces/${workspaceId}/tickets/${created.ticket_id}`, { departmentId: department.id });
      const jobs = await queue.getJobs(['delayed', 'wait']);
      expect(jobs.map((job) => job.data.kind)).toEqual(['incoming']);

      await service.agentSettled(workspaceId, created.ticket_id, new Date());
      await dispatcher.dispatch(jobs[0]!.data);
      expect(recorder.sent).toEqual([{ userId: operator.user.id, notification: expect.objectContaining({ title: 'T-1 is assigned to you' }) }]);
    });

    it('an assignment notifies the assignee, not the one who assigned', async () => {
      const { channel, recorder, dispatcher, http, workspaceId, operator, user } = await subscribed();
      const ticketId = (await ingest(app, channel)).json().ticket_id as string;
      await queue.obliterate({ force: true });

      await http.patch(`/workspaces/${workspaceId}/tickets/${ticketId}`, { assigneeIds: [operator.user.id] });
      await http.patch(`/workspaces/${workspaceId}/tickets/${ticketId}`, { priority: 'urgent' });
      const [job] = await queue.getJobs(['wait']);
      expect(job?.data).toEqual({ kind: 'assigned', workspaceId, ticketId, actorId: user.id, userIds: [operator.user.id] });

      await dispatcher.dispatch(job!.data);
      expect(recorder.sent).toEqual([{ userId: operator.user.id, notification: expect.objectContaining({ title: 'T-1 is assigned to you', urgent: true }) }]);
    });

    it('nobody without a subscription, a membership or an active account is notified', async () => {
      const { channel, recorder, dispatcher, workspaceId, operator } = await subscribed();
      await prisma.user.update({ where: { id: operator.user.id }, data: { disabledAt: new Date() } });
      await prisma.pushSubscription.create({
        data: { id: newId(), userId: operator.user.id, sessionId: (await prisma.session.findFirstOrThrow({ where: { userId: operator.user.id } })).id, endpoint: 'https://push.example.com/x', p256dh: 'k', auth: 'a' },
      });
      await operator.http.put(`/workspaces/${workspaceId}/notification-settings`, { events: { ticketCreated: 'all' } });

      const ticketId = (await ingest(app, channel)).json().ticket_id as string;
      await dispatcher.dispatch((await queue.getJob(incomingJobId(ticketId)))!.data);
      expect(recorder.sent.map((s) => s.userId)).not.toContain(operator.user.id);
    });
  });
});
