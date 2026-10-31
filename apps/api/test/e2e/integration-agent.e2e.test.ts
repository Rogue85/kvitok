import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createSimServer, ingestPayload, type SimServer } from '@kvitok/coffee-sim';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_QUEUE } from '../../src/agent/agent.constants';
import type { LlmRequest } from '../../src/llm/llm.types';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createAgentHarness, type AgentHarness } from '../agent-harness';
import { createApiChannel, createTestApp, ingest, resetDb, setupWorkspace } from '../helpers';
import { result, ScriptedLlm, toolCall } from '../support/scripted-llm';

const SIM_SECRET = 'coffee-sim-test-secret';

/** The agent on the coffee shop simulator: customer search, card, tools, stored facts, manual link. */
describe('agent and integrations', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let agent: AgentHarness;
  let queue: Queue;
  let sim: SimServer;
  let simUrl: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    agent = await createAgentHarness();
    queue = app.get<Queue>(getQueueToken(AGENT_QUEUE));
    sim = createSimServer({ secret: SIM_SECRET, locale: 'ru' });
    simUrl = await sim.listen();
  });

  beforeEach(async () => {
    await resetDb(app);
    await queue.obliterate({ force: true });
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
    for (const key of ['loyalty', 'app', 'stores']) {
      await ctx.http.post(`${base}/departments`, { key, title: key });
    }
    await ctx.http.post(`${base}/departments`, { key: 'triage', title: 'Разбор', isTriage: true });
    const provider = (await ctx.http.post(`${base}/llm-providers`, { name: 'Test', baseUrl: 'http://llm.test/v1', apiKey: 'sk-test', models: [{ id: 'm' }] })).json();
    await ctx.http.put(`${base}/agent/settings`, { enabled: true, providerId: provider.id, model: 'm', maxToolCalls: 6 });
    const { integration } = (await ctx.http.post(`${base}/integrations`, { name: 'Кофейня', baseUrl: simUrl, secret: SIM_SECRET })).json();
    const channel = await createApiChannel(ctx.http, ctx.workspaceId);
    return { ...ctx, base, integration, channel };
  }

  /** A simulator scenario ticket — the same data the backend sees. */
  async function scenarioTicket(channel: Awaited<ReturnType<typeof setup>>['channel'], id: string): Promise<string> {
    const scenario = sim.store.scenarios.find((s) => s.id === id)!;
    const response = await ingest(app, channel, ingestPayload(scenario, sim.store));
    return response.json().ticket_id;
  }

  async function process(ticketId: string) {
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    if (!ticket.agentJobId) throw new Error(`Ticket is not queued (state ${ticket.agentState})`);
    return agent.engine.processTicket(ticketId, ticket.agentJobId);
  }

  const userMessage = (request: LlmRequest) => request.messages[1]!.content as string;
  const toolNames = (request: LlmRequest) => (request.tools ?? []).map((t) => t.name);

  async function steps(ticketId: string) {
    return prisma.agentStep.findMany({ where: { run: { ticketId } }, orderBy: [{ createdAt: 'asc' }, { index: 'asc' }] });
  }

  it('before a run finds the customer and puts the card into the prompt; integration tools are available to the model, a call is recorded as a step', async () => {
    const { channel } = await setup();
    const ticketId = await scenarioTicket(channel, 'receipt-not-on-card');
    const llm = new ScriptedLlm([toolCall('get_transactions', { limit: 5 }), toolCall('submit_result', result({ department: 'loyalty' }))]);
    agent.setLlm(llm);

    await expect(process(ticketId)).resolves.toBe('applied');

    const first = llm.requests[0]!;
    expect(toolNames(first)).toEqual([
      'read_playbook',
      'get_transactions',
      'get_receipt',
      'get_promo_journal',
      'get_promos',
      'get_coupons',
      'get_cups_progress',
      'get_orders',
      'propose_accrue_points',
      'propose_issue_coupon',
      'propose_accrue_cups',
      'propose_refund_order',
      'submit_result',
    ]);
    expect(first.messages[0]!.content).toContain('## Integration knowledge: "Сеть кофеен (симулятор)"');
    expect(userMessage(first)).toContain('## Customer in "Сеть кофеен (симулятор)"\nFound: Анна.');
    expect(userMessage(first)).toMatch(/<integration_data kind="customer_card" fetched_at="[^"]+">.*"balance":340/);
    const toolReply = llm.requests[1]!.messages.at(-1)!;
    expect(toolReply).toMatchObject({ role: 'tool' });
    expect(toolReply.content).toContain('"id":"anna-t1"');

    const recorded = await steps(ticketId);
    expect(recorded.map((s) => s.name)).toEqual(['resolve_customer', 'get_customer_context', 'm', 'get_transactions', 'm', 'submit_result']);
    expect(recorded[3]).toMatchObject({ kind: 'tool', error: null, input: { call: 'tool', tool: 'get_transactions', args: { limit: 5 }, customerRef: 'anna' } });
    expect(await prisma.customerLink.findFirstOrThrow()).toMatchObject({ status: 'found', customerRef: 'anna', displayName: 'Анна', source: 'auto' });
  });

  it('after an operator message — no repeated requests: customer, card and tool data from the previous run; after their lifetime — requested again', async () => {
    const { channel, http, base } = await setup();
    const ticketId = await scenarioTicket(channel, 'receipt-not-on-card');
    agent.setLlm(new ScriptedLlm([toolCall('get_transactions', { limit: 5 }), toolCall('submit_result', result({ department: 'loyalty' }))]));
    await process(ticketId);

    await http.post(`${base}/tickets/${ticketId}/agent/messages`, { body: 'Сумма чека точно 380 ₽' });
    const second = new ScriptedLlm([toolCall('submit_result', { message_to_operator: 'Понял.' })]);
    agent.setLlm(second);
    await expect(process(ticketId)).resolves.toBe('applied');

    const prompt = userMessage(second.requests[0]!);
    expect(prompt).toContain('## Already known from external systems');
    expect(prompt).toMatch(/<integration_data tool="get_transactions" args="\{'limit':5\}" fetched_at="[^"]+" valid_until="[^"]+">.*anna-t1/);
    const runs = await prisma.agentRun.findMany({ where: { ticketId }, orderBy: { createdAt: 'asc' }, include: { steps: true } });
    expect(runs[1]!.steps.filter((s) => s.kind === 'tool' && s.name !== 'submit_result')).toEqual([]);

    // More than the lifetime has passed (get_transactions — 300 s, card — 300 s).
    await prisma.$executeRaw`UPDATE agent_steps SET created_at = created_at - interval '10 minutes' WHERE run_id IN (SELECT id FROM agent_runs WHERE ticket_id = ${ticketId})`;
    await http.post(`${base}/tickets/${ticketId}/agent/messages`, { body: 'Проверь ещё раз' });
    const third = new ScriptedLlm([toolCall('submit_result', { message_to_operator: 'Проверил.' })]);
    agent.setLlm(third);
    await process(ticketId);

    expect(userMessage(third.requests[0]!)).not.toContain('## Already known');
    const last = await prisma.agentRun.findFirstOrThrow({ where: { ticketId }, orderBy: { createdAt: 'desc' }, include: { steps: { orderBy: { index: 'asc' } } } });
    expect(last.steps.map((s) => s.name)).toEqual(['get_customer_context', 'm', 'submit_result']);
  });

  it('customer not found: tools with customer data are hidden, the agent is told to ask for contacts', async () => {
    const { channel } = await setup();
    const ticketId = await scenarioTicket(channel, 'unknown-guest');
    const llm = new ScriptedLlm([toolCall('submit_result', result({ department: 'loyalty' }))]);
    agent.setLlm(llm);

    await process(ticketId);

    expect(toolNames(llm.requests[0]!)).toEqual(['read_playbook', 'identify_customer', 'get_promos', 'submit_result']);
    expect(userMessage(llm.requests[0]!)).toContain('Not found by contacts: phone 79000000015, email petr@example.test.');
    expect(await prisma.customerLink.findFirstOrThrow()).toMatchObject({ status: 'not_found', customerRef: null });
  });

  it('a tool error (another guest\'s receipt) goes back to the model and the run continues; an unavailable integration does not fail the run', async () => {
    const { channel } = await setup();
    const ticketId = await scenarioTicket(channel, 'receipt-not-on-card');
    const llm = new ScriptedLlm([toolCall('get_receipt', { transaction_id: 'boris-t1' }), toolCall('submit_result', result({ department: 'loyalty' }))]);
    agent.setLlm(llm);
    await process(ticketId);

    expect(llm.requests[1]!.messages.at(-1)!.content).toMatch(/^Error: not_found: Чек boris-t1 не найден у этого гостя/);
    expect((await steps(ticketId)).find((s) => s.name === 'get_receipt')).toMatchObject({ error: expect.stringMatching(/^not_found/) });

    const other = await scenarioTicket(channel, 'writeoff-not-applied');
    sim.addFault('resolve', 'error_500');
    const down = new ScriptedLlm([toolCall('submit_result', result({ department: 'loyalty' }))]);
    agent.setLlm(down);
    await expect(process(other)).resolves.toBe('applied');
    expect(userMessage(down.requests[0]!)).toContain('The system is unavailable (internal: Сбой (симуляция))');
    expect(toolNames(down.requests[0]!)).toEqual(['read_playbook', 'get_promos', 'submit_result']);
  });

  it('manual link by phone: a new link — an event, revision++ and a refinement run; an unsuccessful search does not overwrite it', async () => {
    const { channel, http, base, integration } = await setup();
    const ticketId = await scenarioTicket(channel, 'unknown-guest');
    agent.setLlm(new ScriptedLlm([toolCall('submit_result', result({ department: 'loyalty' }))]));
    await process(ticketId);
    const revision = (await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } })).revision;
    const url = `${base}/tickets/${ticketId}/customer-links`;

    const linked = await http.post(`${url}/${integration.id}`, { identities: { phone: '+7 900 000-00-01' } });

    expect(linked.statusCode).toBe(200);
    expect(linked.json()).toMatchObject({ outcome: 'found', link: { status: 'found', customerRef: 'anna', displayName: 'Анна', source: 'manual' } });
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId }, include: { events: true, customer: { include: { identities: true } } } });
    expect(ticket.revision).toBe(revision + 1);
    expect(ticket.events.find((e) => e.type === 'customer_linked')).toMatchObject({ actorType: 'user', data: { displayName: 'Анна', source: 'manual' } });
    expect(ticket.agentPending).toMatchObject({ mode: 'refine', triggers: [{ type: 'customer_linked' }] });
    expect(ticket.customer!.identities.map((i) => i.value)).toContain('79000000001');

    const missed = await http.post(`${url}/${integration.id}`, { identities: { phone: '70000000000' } });
    expect(missed.json()).toMatchObject({ outcome: 'not_found', link: { status: 'found', customerRef: 'anna' } });

    const llm = new ScriptedLlm([toolCall('submit_result', result({ department: 'loyalty' }))]);
    agent.setLlm(llm);
    await process(ticketId);
    expect(userMessage(llm.requests[0]!)).toContain('Found: Анна (linked by the operator).');
    expect(userMessage(llm.requests[0]!)).toContain('The operator linked the customer in the external system');
    expect((await http.get(url)).json()).toMatchObject([{ integrationId: integration.id, status: 'found', source: 'manual', identityTypes: [{ type: 'phone' }, { type: 'email' }, { type: 'card_number' }] }]);
  });

  it('several customers by contacts: the agent sees candidates, an operator chooses; a nonexistent one — 422', async () => {
    const { channel, http, base, integration } = await setup();
    sim.store.guests.get('boris')!.email = 'anna@example.test';
    const ticketId = (await ingest(app, channel, { external_id: 'amb-1', customer: { name: 'Аня', identities: { email: 'anna@example.test' } }, body: 'Баллы не пришли' })).json().ticket_id;
    const llm = new ScriptedLlm([toolCall('submit_result', result({ department: 'loyalty' }))]);
    agent.setLlm(llm);
    await process(ticketId);

    expect(userMessage(llm.requests[0]!)).toMatch(/Several customers found by contacts: Анна \(.*\); Борис/);
    const url = `${base}/tickets/${ticketId}/customer-links/${integration.id}`;
    expect((await http.post(url, { customerRef: 'nobody' })).statusCode).toBe(422);
    expect((await http.post(url, { customerRef: 'boris' })).json()).toMatchObject({ outcome: 'found', link: { customerRef: 'boris', displayName: 'Борис', source: 'manual' } });
  });
});
