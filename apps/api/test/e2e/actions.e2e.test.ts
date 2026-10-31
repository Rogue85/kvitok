import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createSimServer, ingestPayload, type SimServer } from '@kvitok/coffee-sim';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActionExecutor, ActionOutcomeUnknownError } from '../../src/actions/action-executor';
import { ACTIONS_QUEUE } from '../../src/actions/actions.constants';
import { AGENT_QUEUE } from '../../src/agent/agent.constants';
import { IntegrationsService } from '../../src/integrations/integrations.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RealtimeService } from '../../src/realtime/realtime.service';
import { createAgentHarness, type AgentHarness } from '../agent-harness';
import { createApiChannel, createTestApp, ingest, resetDb, setupWorkspace } from '../helpers';
import { result, ScriptedLlm, toolCall } from '../support/scripted-llm';

const SIM_SECRET = 'coffee-sim-test-secret';

/** Actions: the agent proposes (validate), an operator decides, the executor executes exactly once. */
describe('actions in an external system', () => {
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
    // The test executes actions itself instead of the worker: this shows every attempt.
    executor = new ActionExecutor(prisma, app.get(IntegrationsService), app.get(RealtimeService));
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
    for (const key of ['loyalty', 'app', 'stores']) await ctx.http.post(`${base}/departments`, { key, title: key });
    const provider = (await ctx.http.post(`${base}/llm-providers`, { name: 'Test', baseUrl: 'http://llm.test/v1', apiKey: 'sk-test', models: [{ id: 'm' }] })).json();
    await ctx.http.put(`${base}/agent/settings`, { enabled: true, providerId: provider.id, model: 'm' });
    await ctx.http.post(`${base}/integrations`, { name: 'Кофейня', baseUrl: simUrl, secret: SIM_SECRET });
    const channel = await createApiChannel(ctx.http, ctx.workspaceId);
    const ticket = async (scenarioId: string) => {
      const scenario = sim.store.scenarios.find((s) => s.id === scenarioId)!;
      return (await ingest(app, channel, ingestPayload(scenario, sim.store))).json().ticket_id as string;
    };
    return { ...ctx, base, ticket };
  }

  async function process(ticketId: string) {
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    if (!ticket.agentJobId) throw new Error(`Ticket is not queued (state ${ticket.agentState})`);
    return agent.engine.processTicket(ticketId, ticket.agentJobId);
  }

  const proposeAnna = () =>
    toolCall('propose_accrue_points', {
      params: { basis: 'base_cashback', amount: 38, transaction_id: null, receipt_total: 380 },
      reason: 'Чек на 380 ₽ не провели по карте',
      calculation: '380 × 5% = 19',
    });
  const simExecutions = (action: string) => [...sim.store.executions.values()].filter((e) => e.action === action && e.response.status === 'executed');

  it('a proposal passes validate and appears with the analysis; approval executes it exactly once', async () => {
    const { http, base, ticket } = await setup();
    const ticketId = await ticket('receipt-not-on-card');
    const llm = new ScriptedLlm([proposeAnna(), toolCall('submit_result', result({ department: 'loyalty' }))]);
    agent.setLlm(llm);
    await process(ticketId);

    expect((llm.requests[0]!.tools ?? []).map((t) => t.name)).toEqual(
      expect.arrayContaining(['propose_accrue_points', 'propose_issue_coupon', 'propose_accrue_cups', 'propose_refund_order']),
    );
    const reply = llm.requests[1]!.messages.at(-1)!.content as string;
    expect(reply).toContain('Proposal accepted');
    expect(reply).toContain('Начислить 19 баллов');
    expect(reply).toContain('положено 19, а не 38');

    const url = `${base}/tickets/${ticketId}`;
    const [proposal] = (await http.get(`${url}/agent`)).json().actions;
    expect(proposal).toMatchObject({
      status: 'proposed',
      action: 'accrue_points',
      title: 'Начислить баллы',
      normalizedParams: { amount: 19 },
      reason: 'Чек на 380 ₽ не провели по карте',
      calculation: '380 × 5% = 19',
      warnings: [expect.stringContaining('положено 19')],
    });
    const analyzed = await prisma.ticketEvent.findFirstOrThrow({ where: { ticketId, type: 'agent_analyzed' } });
    expect(analyzed.data).toMatchObject({ actions: [{ id: proposal.id, title: 'Начислить баллы' }] });

    const revision = (await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } })).revision;
    const approved = await http.post(`${url}/actions/${proposal.id}/approve`, { comment: 'Чек проверил' });
    expect(approved.json()).toMatchObject({ status: 'approved', decisionComment: 'Чек проверил', decidedBy: { name: expect.any(String) } });
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } })).revision).toBe(revision + 1);
    expect((await http.post(`${url}/actions/${proposal.id}/approve`)).statusCode).toBe(409);

    await expect(executor.execute(proposal.id)).resolves.toBe('executed');
    await expect(executor.execute(proposal.id)).resolves.toBe('skipped');

    expect(sim.store.guests.get('anna')!.balance).toBe(359);
    expect(simExecutions('accrue_points')).toHaveLength(1);
    expect(await prisma.actionProposal.findUniqueOrThrow({ where: { id: proposal.id } })).toMatchObject({ status: 'executed', attempts: 1, externalRef: expect.stringMatching(/^acc-/) });
    const events = (await prisma.ticketEvent.findMany({ where: { ticketId }, orderBy: { createdAt: 'asc' } })).map((e) => e.type);
    expect(events).toEqual(expect.arrayContaining(['action_approved', 'action_executed']));
  });

  it('the execute response was lost: the outcome is learned from the execution status, points are credited once', async () => {
    const { http, base, ticket } = await setup();
    const ticketId = await ticket('writeoff-not-applied');
    agent.setLlm(
      new ScriptedLlm([
        toolCall('propose_accrue_points', { params: { basis: 'writeoff_refund', amount: 120, transaction_id: 'gleb-t1' }, reason: 'Списание не ушло в оплату' }),
        toolCall('submit_result', result({ department: 'loyalty' })),
      ]),
    );
    await process(ticketId);
    const [proposal] = (await http.get(`${base}/tickets/${ticketId}/agent`)).json().actions;
    await http.post(`${base}/tickets/${ticketId}/actions/${proposal.id}/approve`);

    sim.addFault('execute:accrue_points', 'drop_response');
    await expect(executor.execute(proposal.id)).resolves.toBe('executed');

    expect(sim.store.guests.get('gleb')!.balance).toBe(135);
    expect(simExecutions('accrue_points')).toHaveLength(1);
  });

  it('the backend failed before execution: the outcome is unknown, a retry with the same key executes once; when attempts run out — an error and a safe retry', async () => {
    const { http, base, ticket } = await setup();
    const ticketId = await ticket('cups-not-counted');
    agent.setLlm(
      new ScriptedLlm([
        toolCall('propose_accrue_cups', { params: { basis: 'drinks_not_counted', count: 2, transaction_id: 'zoya-t1' }, reason: 'Напитки не засчитались' }),
        toolCall('submit_result', result({ department: 'loyalty' })),
      ]),
    );
    await process(ticketId);
    const [proposal] = (await http.get(`${base}/tickets/${ticketId}/agent`)).json().actions;
    const url = `${base}/tickets/${ticketId}/actions/${proposal.id}`;
    await http.post(`${url}/approve`);

    sim.addFault('execute:accrue_cups', 'error_500');
    await expect(executor.execute(proposal.id)).rejects.toBeInstanceOf(ActionOutcomeUnknownError);
    expect(await prisma.actionProposal.findUniqueOrThrow({ where: { id: proposal.id } })).toMatchObject({ status: 'executing', attempts: 1 });

    await executor.giveUp(proposal.id, 'бэкенд не ответил');
    expect(await prisma.actionProposal.findUniqueOrThrow({ where: { id: proposal.id } })).toMatchObject({ status: 'failed', error: expect.stringMatching(/^The outcome was not confirmed/) });
    expect((await http.post(`${url}/retry`)).json()).toMatchObject({ status: 'approved', error: null });

    await expect(executor.execute(proposal.id)).resolves.toBe('executed');
    expect(sim.store.activeCups('zoya')).toBe(4);
    expect(simExecutions('accrue_cups')).toHaveLength(1);
  });

  it('a rejection is not executed and is visible to the agent with the reason; a full analysis replaces undecided proposals, decided ones stay', async () => {
    const { http, base, ticket } = await setup();
    const ticketId = await ticket('receipt-not-on-card');
    agent.setLlm(new ScriptedLlm([proposeAnna(), toolCall('submit_result', result({ department: 'loyalty' }))]));
    await process(ticketId);
    const url = `${base}/tickets/${ticketId}`;
    const [rejected] = (await http.get(`${url}/agent`)).json().actions;
    await http.post(`${url}/actions/${rejected.id}/reject`, { comment: 'Гость не подтвердил сумму' });

    await http.post(`${url}/agent/run`, { mode: 'triage' });
    const second = new ScriptedLlm([
      toolCall('propose_accrue_cups', { params: { basis: 'receipt_not_on_card', count: 1, transaction_id: null }, reason: 'Латте не по карте' }),
      toolCall('submit_result', result({ department: 'loyalty' })),
    ]);
    agent.setLlm(second);
    await process(ticketId);
    const prompt = second.requests[0]!.messages[1]!.content as string;
    expect(prompt).toContain('## Actions on the ticket');
    expect(prompt).toMatch(/\[rejected by the operator\] Начислить баллы \(accrue_points\) .*reason: "Гость не подтвердил сумму"/);

    await http.post(`${url}/agent/run`, { mode: 'triage' });
    agent.setLlm(new ScriptedLlm([toolCall('submit_result', result({ department: 'loyalty' }))]));
    await process(ticketId);

    const statuses = (await http.get(`${url}/agent`)).json().actions.map((a: { action: string; status: string }) => [a.action, a.status]);
    expect(statuses).toEqual([
      ['accrue_points', 'rejected'],
      ['accrue_cups', 'superseded'],
    ]);
    expect(simExecutions('accrue_points')).toHaveLength(0);
  });

  it('a partial run on an operator message does not touch proposals unless the agent changes them; drop_pending_actions withdraws them', async () => {
    const { http, base, ticket } = await setup();
    const ticketId = await ticket('receipt-not-on-card');
    agent.setLlm(new ScriptedLlm([proposeAnna(), toolCall('submit_result', result({ department: 'loyalty' }))]));
    await process(ticketId);
    const url = `${base}/tickets/${ticketId}`;

    await http.post(`${url}/agent/messages`, { body: 'Сумма точно 380?' });
    const chat = new ScriptedLlm([toolCall('submit_result', { message_to_operator: 'Да, со слов гостя.' })]);
    agent.setLlm(chat);
    await process(ticketId);
    expect((chat.requests[0]!.tools ?? []).find((t) => t.name === 'submit_result')!.parameters).toMatchObject({ properties: { drop_pending_actions: { type: 'boolean' } } });
    expect((await http.get(`${url}/agent`)).json().actions.map((a: { status: string }) => a.status)).toEqual(['proposed']);

    await http.post(`${url}/agent/messages`, { body: 'Не начисляй, сначала уточним у гостя' });
    agent.setLlm(new ScriptedLlm([toolCall('submit_result', { message_to_operator: 'Снял предложение.', drop_pending_actions: true })]));
    await process(ticketId);
    expect((await http.get(`${url}/agent`)).json().actions.map((a: { status: string }) => a.status)).toEqual(['superseded']);
  });

  it('the backend rejected the parameters — an error for the agent, no proposal', async () => {
    const { http, base, ticket } = await setup();
    const ticketId = await ticket('points-already-accrued');
    const llm = new ScriptedLlm([
      toolCall('propose_accrue_points', { params: { basis: 'base_cashback', amount: 26, transaction_id: 'vera-t1' }, reason: 'Баллы не пришли' }),
      toolCall('submit_result', result({ department: 'loyalty' })),
    ]);
    agent.setLlm(llm);
    await process(ticketId);

    expect(llm.requests[1]!.messages.at(-1)!.content).toMatch(/^The backend rejected the proposal: transaction_id: Баллы по чеку уже начислены: 26/);
    expect((await http.get(`${base}/tickets/${ticketId}/agent`)).json().actions).toEqual([]);
  });
});

