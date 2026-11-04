import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createSimServer, ingestPayload, type SimServer } from '@kvitok/coffee-sim';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActionExecutor } from '../../src/actions/action-executor';
import { ACTIONS_QUEUE } from '../../src/actions/actions.constants';
import { AGENT_QUEUE } from '../../src/agent/agent.constants';
import { AgentTriggerService } from '../../src/agent/agent-trigger.service';
import { IntegrationsService } from '../../src/integrations/integrations.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RealtimeService } from '../../src/realtime/realtime.service';
import { createAgentHarness, type AgentHarness } from '../agent-harness';
import { client, createApiChannel, createTestApp, createUser, ingest, login, resetDb, setupWorkspace } from '../helpers';
import { result, ScriptedLlm, toolCall } from '../support/scripted-llm';

const SIM_SECRET = 'coffee-sim-test-secret';

/** Manual actions: an operator proposes one from the ticket, it waits for "Execute", executing it replaces the other proposals. */
describe('manual actions of operators', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let agent: AgentHarness;
  let executor: ActionExecutor;
  let sim: SimServer;
  let simUrl: string;
  const queues: Queue[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    agent = await createAgentHarness();
    executor = new ActionExecutor(prisma, app.get(IntegrationsService), app.get(RealtimeService), app.get(AgentTriggerService));
    queues.push(app.get<Queue>(getQueueToken(AGENT_QUEUE)), app.get<Queue>(getQueueToken(ACTIONS_QUEUE)));
    sim = createSimServer({ secret: SIM_SECRET, locale: 'ru' });
    simUrl = await sim.listen();
  });

  beforeEach(async () => {
    await resetDb(app);
    for (const queue of queues) await queue.obliterate({ force: true });
    sim.reset();
  });

  afterAll(async () => {
    await sim.close();
    await agent.context.close();
    await app.close();
  });

  async function setup() {
    const ctx = await setupWorkspace(app);
    const base = `/workspaces/${ctx.workspaceId}`;
    await ctx.http.post(`${base}/departments`, { key: 'loyalty', title: 'loyalty' });
    const provider = (await ctx.http.post(`${base}/llm-providers`, { name: 'Test', baseUrl: 'http://llm.test/v1', apiKey: 'sk-test', models: [{ id: 'm' }] })).json();
    await ctx.http.put(`${base}/agent/settings`, { enabled: true, providerId: provider.id, model: 'm' });
    const { integration } = (await ctx.http.post(`${base}/integrations`, { name: 'Кофейня', baseUrl: simUrl, secret: SIM_SECRET })).json();
    const channel = await createApiChannel(ctx.http, ctx.workspaceId);
    const scenario = sim.store.scenarios.find((s) => s.id === 'receipt-not-on-card')!;
    const ticketId = (await ingest(app, channel, ingestPayload(scenario, sim.store))).json().ticket_id as string;
    // The first analysis links the customer; the agent proposes nothing here.
    agent.setLlm(new ScriptedLlm([toolCall('submit_result', result({ department: 'loyalty' }))]));
    await process(ticketId);
    return { ...ctx, base, ticketId, integrationId: integration.id as string, url: `${base}/tickets/${ticketId}` };
  }

  async function process(ticketId: string) {
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    if (!ticket.agentJobId) throw new Error(`Ticket is not queued (state ${ticket.agentState})`);
    return agent.engine.processTicket(ticketId, ticket.agentJobId);
  }

  const goodwill = (integrationId: string, extra: Record<string, unknown> = {}) => ({
    integrationId,
    action: 'adjust_points',
    params: { amount: 50, comment: 'Кофейня перепутала заказ' },
    reason: 'Гость ждал заказ 20 минут',
    ...extra,
  });
  const actions = async (http: Awaited<ReturnType<typeof setup>>['http'], url: string) =>
    (await http.get(`${url}/agent`)).json().actions as Array<{ id: string; action: string; source: string; status: string; replacedById: string | null }>;

  it('the catalog lists the actions for operators; operator-only ones are hidden from the agent', async () => {
    const { http, url, integrationId, ticketId } = await setup();
    const catalog = (await http.get(`${url}/actions/catalog`)).json();
    expect(catalog).toEqual([
      expect.objectContaining({ integrationId, title: 'Кофейня', blocked: null, customer: { displayName: expect.any(String), confirmed: true } }),
    ]);
    const names = catalog[0].actions.map((a: { name: string; operatorOnly: boolean }) => [a.name, a.operatorOnly]);
    expect(names).toEqual(expect.arrayContaining([['accrue_points', false], ['adjust_points', true]]));
    expect(catalog[0].actions.find((a: { name: string }) => a.name === 'adjust_points').inputSchema).toMatchObject({ required: ['amount', 'comment'] });

    await http.post(`${url}/agent/run`, { mode: 'triage' });
    const llm = new ScriptedLlm([toolCall('submit_result', result({ department: 'loyalty' }))]);
    agent.setLlm(llm);
    await process(ticketId);
    const tools = (llm.requests[0]!.tools ?? []).map((t) => t.name);
    expect(tools).toContain('propose_accrue_points');
    expect(tools).not.toContain('propose_adjust_points');
  });

  it('proposing: invalid parameters come back with the backend errors; a valid one is a card waiting for "Execute" without waking the agent', async () => {
    const { http, url, integrationId, ticketId, user } = await setup();
    const invalid = await http.post(`${url}/actions`, goodwill(integrationId, { params: { amount: 500, comment: 'много' } }));
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error.details.errors).toEqual([{ path: 'amount', message: expect.stringContaining('не больше 300') }]);
    expect(await prisma.actionProposal.count({ where: { ticketId } })).toBe(0);
    expect((await http.post(`${url}/actions`, goodwill(integrationId, { action: 'nope' }))).statusCode).toBe(422);

    const before = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    const created = await http.post(`${url}/actions`, goodwill(integrationId));
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      source: 'operator',
      status: 'proposed',
      runId: null,
      createdBy: { id: user.id },
      refreshDraft: true,
      preview: expect.stringContaining('Начислить 50 баллов компенсации'),
      reason: 'Гость ждал заказ 20 минут',
    });
    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    expect(after.revision).toBe(before.revision);
    expect(after.agentState).toBe('idle');
    expect(await prisma.ticketEvent.count({ where: { ticketId, type: 'action_proposed_by_operator' } })).toBe(1);
    expect([...sim.store.executions.values()]).toHaveLength(0);
  });

  it('the agent keeps a manual card and sees it as the operator\'s; editing supersedes the old card', async () => {
    const { http, url, integrationId, ticketId } = await setup();
    const first = (await http.post(`${url}/actions`, goodwill(integrationId))).json();

    await http.post(`${url}/agent/run`, { mode: 'triage' });
    const llm = new ScriptedLlm([toolCall('submit_result', result({ department: 'loyalty' }))]);
    agent.setLlm(llm);
    await process(ticketId);
    const prompt = llm.requests[0]!.messages[1]!.content as string;
    expect(prompt).toMatch(/\[awaiting the operator, proposed by the operator by hand\] Баллы в качестве компенсации \(adjust_points\).*operator's reason: "Гость ждал заказ 20 минут"/);
    expect((await actions(http, url)).map((a) => a.status)).toEqual(['proposed']);

    const edited = (await http.post(`${url}/actions`, goodwill(integrationId, { params: { amount: 70, comment: 'Кофейня перепутала заказ' }, replaces: first.id }))).json();
    expect(await actions(http, url)).toEqual([
      expect.objectContaining({ id: first.id, status: 'superseded', replacedById: edited.id }),
      expect.objectContaining({ id: edited.id, status: 'proposed' }),
    ]);
    // Only a pending manual card can be edited.
    expect((await http.post(`${url}/actions`, goodwill(integrationId, { replaces: first.id }))).statusCode).toBe(409);
  });

  it('executing replaces every other pending proposal, sends who started it and updates the reply', async () => {
    const { http, url, integrationId, ticketId, user } = await setup();
    await http.post(`${url}/agent/run`, { mode: 'triage' });
    agent.setLlm(
      new ScriptedLlm([
        toolCall('propose_accrue_points', { params: { basis: 'base_cashback', amount: 19, transaction_id: null, receipt_total: 380 }, reason: 'Чек не провели' }),
        toolCall('submit_result', result({ department: 'loyalty' })),
      ]),
    );
    await process(ticketId);
    const manual = (await http.post(`${url}/actions`, goodwill(integrationId))).json();
    const [agentProposal] = (await actions(http, url)).filter((a) => a.source === 'agent');

    const approved = await http.post(`${url}/actions/${manual.id}/approve`);
    expect(approved.statusCode).toBe(200);
    expect(await actions(http, url)).toEqual([
      expect.objectContaining({ id: agentProposal!.id, status: 'rejected', replacedById: manual.id }),
      expect.objectContaining({ id: manual.id, status: 'approved' }),
    ]);
    expect((await http.post(`${url}/actions/${agentProposal!.id}/approve`)).statusCode).toBe(409);

    await expect(executor.execute(manual.id)).resolves.toBe('executed');
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    const [execution] = [...sim.store.executions.values()];
    expect(execution).toMatchObject({ action: 'adjust_points', context: { source: 'operator', ticket: `T-${ticket.number}`, operator: { email: user.email } } });

    // "Update the reply": a partial run with the action in the task.
    expect(ticket.agentState).toBe('queued');
    const llm = new ScriptedLlm([toolCall('submit_result', { message_to_operator: 'Добавил в ответ про компенсацию.', reply_body: '<p>Начислили 50 баллов.</p>' })]);
    agent.setLlm(llm);
    await process(ticketId);
    const prompt = llm.requests[0]!.messages[1]!.content as string;
    expect(prompt).toContain('The operator performed an action by hand');
    expect(prompt).toMatch(/\[rejected — replaced by the operator's action: Баллы в качестве компенсации/);
    expect((await http.get(`${url}/agent`)).json().draft.bodyHtml).toContain('Начислили 50 баллов');

    // A correction, not a rejection: the quality report counts it as replaced.
    const { quality } = (await http.get(`/workspaces/${(await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } })).workspaceId}/analytics?days=7`)).json();
    expect(quality.manualActions).toEqual({ executed: 1, replaced: 1, missed: 0 });
    expect(quality.actions.rejected ?? 0).toBe(1);
  });

  it('a proposal a colleague approved after the confirmation opened stops the execution that promised to reject it', async () => {
    const { http, url, integrationId, ticketId } = await setup();
    await http.post(`${url}/agent/run`, { mode: 'triage' });
    agent.setLlm(
      new ScriptedLlm([
        toolCall('propose_accrue_points', { params: { basis: 'base_cashback', amount: 19, transaction_id: null, receipt_total: 380 }, reason: 'Чек не провели' }),
        toolCall('submit_result', result({ department: 'loyalty' })),
      ]),
    );
    await process(ticketId);
    const manual = (await http.post(`${url}/actions`, goodwill(integrationId))).json();
    const [agentProposal] = (await actions(http, url)).filter((a) => a.source === 'agent');

    // The confirmation listed the agent's proposal as rejected; a colleague approves it first.
    expect((await http.post(`${url}/actions/${agentProposal!.id}/approve`)).statusCode).toBe(200);
    const stopped = await http.post(`${url}/actions/${manual.id}/approve`, { pending: [agentProposal!.id] });
    expect(stopped.statusCode).toBe(409);
    expect(await actions(http, url)).toEqual([
      expect.objectContaining({ id: agentProposal!.id, status: 'approved' }),
      expect.objectContaining({ id: manual.id, status: 'proposed' }),
    ]);
    // Seen anew, nothing is promised: the operator decides knowing the other one runs.
    expect((await http.post(`${url}/actions/${manual.id}/approve`, { pending: [] })).statusCode).toBe(200);
  });

  it('an "update the reply" run that goes stale passes the action on to the next run', async () => {
    const { http, url, integrationId, ticketId } = await setup();
    const manual = (await http.post(`${url}/actions`, goodwill(integrationId))).json();
    await http.post(`${url}/actions/${manual.id}/approve`);
    await expect(executor.execute(manual.id)).resolves.toBe('executed');

    // The operator changes the ticket while the agent rewrites the reply: the run is stale.
    agent.setLlm(
      new ScriptedLlm([
        async () => {
          await prisma.ticket.update({ where: { id: ticketId }, data: { revision: { increment: 1 } } });
          return toolCall('submit_result', { message_to_operator: 'Обновил ответ.', reply_body: '<p>Начислили 50 баллов.</p>' });
        },
      ]),
    );
    await expect(process(ticketId)).resolves.toBe('stale');
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    expect(ticket.agentPending).toMatchObject({ mode: 'refine', triggers: expect.arrayContaining([{ type: 'action_executed', actionId: manual.id, userId: expect.any(String) }]) });

    const llm = new ScriptedLlm([toolCall('submit_result', { message_to_operator: 'Обновил ответ.', reply_body: '<p>Начислили 50 баллов.</p>' })]);
    agent.setLlm(llm);
    await process(ticketId);
    expect(llm.requests[0]!.messages[1]!.content as string).toContain('The operator performed an action by hand');
  });

  it('an action the agent could have proposed, done by hand, is missed by the agent', async () => {
    const { http, url, integrationId, base } = await setup();
    const manual = (
      await http.post(`${url}/actions`, {
        integrationId,
        action: 'accrue_points',
        params: { basis: 'base_cashback', amount: 19, transaction_id: null, receipt_total: 380 },
        reason: 'Гость прислал фото чека',
        refreshDraft: false,
      })
    ).json();
    await http.post(`${url}/actions/${manual.id}/approve`);
    await expect(executor.execute(manual.id)).resolves.toBe('executed');
    const { quality } = (await http.get(`${base}/analytics?days=7`)).json();
    expect(quality.manualActions).toEqual({ executed: 1, replaced: 0, missed: 1 });
  });

  it('without "update the reply" nothing runs; an agent proposal approval rejects nothing; a viewer cannot propose', async () => {
    const { http, url, integrationId, ticketId, workspaceId } = await setup();
    const manual = (await http.post(`${url}/actions`, goodwill(integrationId, { refreshDraft: false }))).json();
    await http.post(`${url}/actions/${manual.id}/approve`);
    await expect(executor.execute(manual.id)).resolves.toBe('executed');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } })).agentState).toBe('idle');

    const viewer = await createUser(app);
    await prisma.membership.create({ data: { userId: viewer.id, workspaceId, role: 'viewer' } });
    const viewerHttp = client(app, await login(app, viewer));
    expect((await viewerHttp.post(`${url}/actions`, goodwill(integrationId))).statusCode).toBe(403);
    expect((await viewerHttp.get(`${url}/actions/catalog`)).statusCode).toBe(403);
  });

  it('an unconfirmed customer blocks proposing', async () => {
    const { http, url, integrationId } = await setup();
    await prisma.customerLink.updateMany({ where: { integrationId }, data: { confirmed: false } });
    expect((await http.get(`${url}/actions/catalog`)).json()[0].blocked).toBe('not_confirmed');
    expect((await http.post(`${url}/actions`, goodwill(integrationId))).statusCode).toBe(409);
  });
});
