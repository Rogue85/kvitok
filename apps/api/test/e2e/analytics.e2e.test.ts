import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AnalyticsDto } from '@kvitok/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../src/common/ids';
import { PrismaService } from '../../src/prisma/prisma.service';
import { client, createApiChannel, createTestApp, createUser, ingest, login, resetDb, setupWorkspace } from '../helpers';

describe('analytics', () => {
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
    const base = `/workspaces/${ctx.workspaceId}`;
    const channel = await createApiChannel(ctx.http, ctx.workspaceId);
    const department = (await ctx.http.post(`${base}/departments`, { key: 'loyalty', title: 'Лояльность' })).json();
    const ticket = async () => (await ingest(app, channel, { body: 'Баллы не пришли' })).json().ticket_id as string;
    const run = (ticketId: string, data: Record<string, unknown> = {}) =>
      prisma.agentRun.create({
        data: {
          id: newId(),
          workspaceId: ctx.workspaceId,
          ticketId,
          mode: 'triage',
          trigger: { type: 'ticket_created' },
          status: 'applied',
          inputRevision: 0,
          model: 'model-a',
          tokensIn: 1000,
          tokensOut: 100,
          cost: 0.01,
          ...data,
        },
      });
    return { ...ctx, base, channel, department, ticket, run };
  }

  it('agent spending in the workspace currency: per ticket, by department and model; trial runs and older runs apart', async () => {
    const { http, base, department, ticket, run } = await setup();
    expect((await http.patch(base, { currency: 'eur' })).json()).toMatchObject({ currency: 'EUR' });
    const a = await ticket();
    const b = await ticket();
    await http.patch(`${base}/tickets/${a}`, { departmentId: department.id, status: 'resolved' });
    await run(a);
    await run(a, { mode: 'refine', trigger: { type: 'operator_message' }, model: 'model-b', cost: 0.02 });
    await run(a, { dryRun: true, cost: 0.5 });
    await run(b, { cost: 0.04, status: 'failed' });
    await run(b, { cost: 1.5 });
    await run(b, { cost: null, tokensIn: 400, tokensOut: 100 });
    await run(b, { cost: 9, createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) });

    const response = await http.get(`${base}/analytics?days=30&tz=Europe/Moscow`);
    expect(response.statusCode).toBe(200);
    const report: AnalyticsDto = response.json();

    expect(report.period).toMatchObject({ days: 30, timeZone: 'Europe/Moscow' });
    expect(report.currency).toBe('EUR');
    expect(report.agent.usage).toEqual({ runs: 5, tokensIn: 4400, tokensOut: 500, cost: 1.57, unpricedRuns: 1 });
    expect(report.agent.dryRuns).toMatchObject({ runs: 1, cost: 0.5 });
    expect(report.agent).toMatchObject({ ticketsWithRuns: 2, costPerTicket: 0.785, byStatus: { applied: 4, failed: 1 } });
    expect(report.agent.byDepartment).toEqual(
      expect.arrayContaining([
        { key: department.id, runs: 2, tickets: 1, tokens: 2200, cost: 0.03, unpricedRuns: 0 },
        { key: null, runs: 3, tickets: 1, tokens: 2700, cost: 1.54, unpricedRuns: 1 },
      ]),
    );
    expect(report.agent.byModel.map((r) => [r.key, r.runs, r.cost])).toEqual([
      ['model-a', 4, 1.55],
      ['model-b', 1, 0.02],
    ]);
    expect(report.agent.byTrigger.find((r) => r.key === 'operator_message')).toMatchObject({ runs: 1, cost: 0.02 });
    expect(report.agent.topTickets.map((t) => [t.id, t.runs, t.cost])).toEqual([
      [b, 3, 1.54],
      [a, 2, 0.03],
    ]);

    expect(report.days).toHaveLength(30);
    expect(report.days.at(-1)).toMatchObject({ cost: 1.57, runs: 5, ticketsCreated: 2, ticketsResolved: 1 });
    expect(report.days.slice(0, -1).every((d) => d.runs === 0)).toBe(true);
    expect(report.tickets).toMatchObject({ created: 2, resolved: 1, open: 1, byStatus: { resolved: 1, new: 1 } });
    expect(report.tickets.resolutionMedianMs).toBeGreaterThanOrEqual(0);
  });

  it('an empty workspace and an unknown time zone', async () => {
    const { http, base } = await setup();

    const report: AnalyticsDto = (await http.get(`${base}/analytics?days=7&tz=Mars/Olympus`)).json();

    expect(report.period.timeZone).toBe('UTC');
    expect(report.currency).toBe('USD');
    expect(report.agent).toMatchObject({ ticketsWithRuns: 0, costPerTicket: null, avgDurationMs: null, topTickets: [] });
    expect(report.days).toHaveLength(7);
    expect(report.tickets).toMatchObject({ created: 0, firstResponseMedianMs: null });
  });

  it('every member reads it, other workspaces do not', async () => {
    const { workspaceId, base } = await setup();
    const viewer = await createUser(app);
    await prisma.membership.create({ data: { userId: viewer.id, workspaceId, role: 'viewer' } });
    const outsider = await setupWorkspace(app);

    expect((await client(app, await login(app, viewer)).get(`${base}/analytics`)).statusCode).toBe(200);
    expect((await outsider.http.get(`${base}/analytics`)).statusCode).toBe(404);
    expect((await outsider.http.get(`/workspaces/${outsider.workspaceId}/analytics?days=0`)).statusCode).toBe(422);
  });
});
