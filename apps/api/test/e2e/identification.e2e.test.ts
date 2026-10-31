import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createSimServer, type SimServer } from '@kvitok/coffee-sim';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_QUEUE } from '../../src/agent/agent.constants';
import type { LlmRequest } from '../../src/llm/llm.types';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createAgentHarness, type AgentHarness } from '../agent-harness';
import { eml } from '../fixtures/mail';
import { createApiChannel, createMailbox, createTestApp, ingest, resetDb, setupWorkspace } from '../helpers';
import { result, ScriptedLlm, toolCall } from '../support/scripted-llm';
import { createWorkerHarness, type WorkerHarness } from '../worker-harness';

const SIM_SECRET = 'coffee-sim-test-secret';

/** Customer identification: form emails, identities in message text, the linking policy and the operator's decisions. */
describe('customer identification', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let agent: AgentHarness;
  let worker: WorkerHarness;
  let queue: Queue;
  let sim: SimServer;
  let simUrl: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    agent = await createAgentHarness();
    worker = await createWorkerHarness();
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
    await worker.context.close();
    await agent.context.close();
    await app.close();
  });

  async function setup(options: { claimLinking?: string } = {}) {
    const ctx = await setupWorkspace(app);
    const base = `/workspaces/${ctx.workspaceId}`;
    await ctx.http.post(`${base}/departments`, { key: 'loyalty', title: 'Лояльность' });
    const provider = (await ctx.http.post(`${base}/llm-providers`, { name: 'Test', baseUrl: 'http://llm.test/v1', apiKey: 'sk-test', models: [{ id: 'm' }] })).json();
    await ctx.http.put(`${base}/agent/settings`, { enabled: true, providerId: provider.id, model: 'm', maxToolCalls: 6 });
    const { integration } = (await ctx.http.post(`${base}/integrations`, { name: 'Кофейня', baseUrl: simUrl, secret: SIM_SECRET })).json();
    if (options.claimLinking) {
      await ctx.http.patch(`${base}/integrations/${integration.id}`, { claimLinking: options.claimLinking });
    }
    const api = await createApiChannel(ctx.http, ctx.workspaceId);
    const mailboxId = await createMailbox(ctx.http, ctx.workspaceId);
    const mailbox = await prisma.channel.findUniqueOrThrow({ where: { id: mailboxId } });
    return { ...ctx, base, integration, api, mailbox };
  }

  async function process(ticketId: string) {
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    if (!ticket.agentJobId) throw new Error(`Ticket is not queued (state ${ticket.agentState})`);
    return agent.engine.processTicket(ticketId, ticket.agentJobId);
  }

  const userMessage = (request: LlmRequest) => request.messages[1]!.content as string;
  const toolNames = (request: LlmRequest) => (request.tools ?? []).map((t) => t.name);
  const guest = (id: string) => sim.store.guests.get(id)!;
  const submit = () => toolCall('submit_result', result({ department: 'loyalty' }));

  const formRule = {
    name: 'Форма приложения',
    conditions: { field: 'from.email', op: 'eq', value: 'noreply@app.example' },
    customerFrom: 'reply_to',
    extract: [
      { identityType: 'phone', source: 'body', pattern: 'Телефон:\\s*(.+)', trust: 'claimed' },
      { identityType: 'name', source: 'body', pattern: 'Имя:\\s*(.+)', trust: 'claimed' },
    ],
  };
  const formEmail = (name: string, email: string, phone: string) =>
    eml({
      from: 'Stars <noreply@app.example>',
      replyTo: `${name} <${email}>`,
      subject: 'Новое обращение в поддержку: Баллы',
      text: `Имя: ${name}\nТелефон: ${phone}\nEmail: ${email}\nБаллы не пришли.`,
    });

  it('rules: create with an audit entry, a rule taking the customer from the text needs an email extract, check on a ticket', async () => {
    const { http, base, mailbox } = await setup();
    const created = await http.post(`${base}/identification/rules`, formRule);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: 'Форма приложения', customerFrom: 'reply_to', enabled: true, stop: false });
    expect(await prisma.auditLog.findFirst({ where: { entity: 'identification_rule', action: 'create' } })).not.toBeNull();

    const invalid = await http.post(`${base}/identification/rules`, { ...formRule, customerFrom: 'extracted_email' });
    expect(invalid.statusCode).toBe(422);

    await worker.mailIngest.ingest(mailbox, await formEmail('Анна', 'anna@example.test', '+7 (900) 000-00-01'));
    const ticket = await prisma.ticket.findFirstOrThrow();
    const check = (await http.post(`${base}/identification/check`, { ticketId: ticket.id })).json();
    expect(check).toMatchObject({
      matched: [{ name: 'Форма приложения' }],
      customerFrom: 'reply_to',
      customer: { email: 'anna@example.test', name: 'Анна' },
      identities: expect.arrayContaining([
        { type: 'email', value: 'anna@example.test', trust: 'trusted', source: 'sender', ruleName: null, integrationName: null },
        expect.objectContaining({ type: 'phone', value: '79000000001', trust: 'claimed', source: 'rule' }),
      ]),
    });

    expect((await http.patch(`${base}/identification/settings`, { trustSender: 'authenticated' })).json()).toEqual({ trustSender: 'authenticated' });
    expect((await http.get(`${base}/identification/settings`)).json()).toEqual({ trustSender: 'authenticated' });
  });

  it('a form email: the customer comes from Reply-To and gets the reply, the form sender is no participant; two forms are two customers', async () => {
    const { http, base, mailbox } = await setup();
    await http.post(`${base}/identification/rules`, formRule);

    await worker.mailIngest.ingest(mailbox, await formEmail('Анна', 'anna@example.test', '+7 (900) 000-00-01'));
    await worker.mailIngest.ingest(mailbox, await formEmail('Борис', 'boris@example.test', '8 900 000 00 02'));

    const tickets = await prisma.ticket.findMany({
      orderBy: { number: 'asc' },
      include: { participants: true, customer: { include: { identities: true } }, identityClaims: true, events: true },
    });
    expect(tickets).toHaveLength(2);
    const [first, second] = tickets;
    expect(first!.customer).toMatchObject({ name: 'Анна', identities: [expect.objectContaining({ type: 'email', value: 'anna@example.test' })] });
    expect(second!.customer).toMatchObject({ name: 'Борис' });
    expect(first!.customerId).not.toBe(second!.customerId);
    expect(first!.participants.map((p) => [p.email, p.role])).toEqual([['anna@example.test', 'customer']]);
    expect(first!.identityClaims).toEqual([expect.objectContaining({ type: 'phone', value: '79000000001', source: 'rule', trust: 'claimed', status: 'pending', ruleName: 'Форма приложения' })]);
    expect(first!.events.find((e) => e.type === 'identities_found')).toMatchObject({ data: { identities: [{ type: 'phone', value: '79000000001' }] } });
  });

  it('identities in the text: a card in a follow-up reply is a claim, a number only in the quoted history is not', async () => {
    const { mailbox } = await setup();
    const first = await eml({ from: 'Пётр <petr@client.example>', subject: 'Баллы', text: 'Баллы не пришли.' });
    await worker.mailIngest.ingest(mailbox, first);
    const ticket = await prisma.ticket.findFirstOrThrow({ include: { messages: true } });
    const firstId = ticket.messages[0]!.rfcMessageId!;

    await worker.mailIngest.ingest(mailbox, await eml({ from: 'Пётр <petr@client.example>', subject: 'Re: Баллы', inReplyTo: firstId, text: `Моя карта ${guest('anna').cardNumber}` }));
    await worker.mailIngest.ingest(
      mailbox,
      await eml({ from: 'Пётр <petr@client.example>', subject: 'Re: Баллы', inReplyTo: firstId, text: `Спасибо.\n\nВ пятницу Пётр пишет:\n> карта ${guest('boris').cardNumber}` }),
    );

    const claims = await prisma.identityClaim.findMany({ where: { ticketId: ticket.id } });
    expect(claims).toEqual([expect.objectContaining({ type: 'card_number', value: guest('anna').cardNumber, source: 'manifest', trust: 'claimed', integrationId: expect.any(String) })]);
  });

  it('only authenticated senders are trusted: an unauthenticated From becomes a claim, an authenticated one is the customer', async () => {
    const { http, base, mailbox } = await setup();
    await http.patch(`${base}/identification/settings`, { trustSender: 'authenticated' });

    await worker.mailIngest.ingest(mailbox, await eml({ from: 'Анна <anna@example.test>', subject: 'Без проверки', text: 'Баллы не пришли.' }));
    await worker.mailIngest.ingest(
      mailbox,
      await eml({ from: 'Анна <anna@example.test>', subject: 'С проверкой', text: 'Баллы не пришли.', headers: { 'Authentication-Results': 'mx.example.com; dmarc=pass header.from=example.test' } }),
    );

    const [plain, verified] = await prisma.ticket.findMany({ orderBy: { number: 'asc' }, include: { customer: { include: { identities: true } }, identityClaims: true, participants: true } });
    expect(plain!.customer!.identities).toEqual([]);
    expect(plain!.identityClaims).toEqual([expect.objectContaining({ type: 'email', value: 'anna@example.test', source: 'sender', trust: 'claimed' })]);
    expect(plain!.participants.map((p) => p.email)).toEqual(['anna@example.test']);
    expect(verified!.customer!.identities.map((i) => i.value)).toEqual(['anna@example.test']);
    expect(verified!.identityClaims).toEqual([]);
  });

  it('suggest (the default): a customer found by a card from the text waits for the operator; choosing links them and keeps the card', async () => {
    const { http, base, api, integration } = await setup();
    const card = guest('anna').cardNumber;
    const ticketId = (await ingest(app, api, { external_id: 's-1', customer: { name: 'Пётр', identities: { email: 'petr@example.test' } }, body: `Моя карта ${card}, баллы не пришли` })).json().ticket_id;
    const llm = new ScriptedLlm([submit()]);
    agent.setLlm(llm);
    await process(ticketId);

    const link = await prisma.customerLink.findFirstOrThrow();
    expect(link).toMatchObject({ status: 'not_found', confirmed: true, pending: { kind: 'suggestion', options: [{ customerRef: 'anna', matchedBy: ['card_number'] }] } });
    expect(userMessage(llm.requests[0]!)).toContain("waits for the operator's decision in the timeline");
    expect(toolNames(llm.requests[0]!)).not.toContain('identify_customer');
    const event = await prisma.ticketEvent.findFirstOrThrow({ where: { ticketId, type: 'customer_identification' } });
    expect(event.data).toMatchObject({ kind: 'suggestion', identities: [{ type: 'card_number', value: card, source: 'manifest' }] });
    expect((link.pending as { eventId: string }).eventId).toBe(event.id);

    const links = (await http.get(`${base}/tickets/${ticketId}/customer-links`)).json();
    expect(links[0]).toMatchObject({ pending: { kind: 'suggestion' }, claims: [{ type: 'card_number', status: 'matched' }] });

    const revision = (await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } })).revision;
    const decided = await http.post(`${base}/tickets/${ticketId}/customer-links/${integration.id}/decide`, { decision: 'choose', customerRef: 'anna' });
    expect(decided.statusCode).toBe(200);
    expect(decided.json()).toMatchObject({ status: 'found', customerRef: 'anna', source: 'manual', confirmed: true, pending: null, claims: [{ status: 'confirmed' }] });
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId }, include: { customer: { include: { identities: true } }, events: true } });
    expect(ticket.revision).toBe(revision + 1);
    expect(ticket.customer!.identities.map((i) => i.value)).toContain(card);
    expect(ticket.events.find((e) => e.type === 'customer_linked')).toMatchObject({ actorType: 'user', data: { displayName: 'Анна', via: 'identification' } });
    expect(ticket.agentPending).toMatchObject({ mode: 'refine', triggers: [{ type: 'customer_linked' }] });

    const again = await http.post(`${base}/tickets/${ticketId}/customer-links/${integration.id}/decide`, { decision: 'reject' });
    expect(again.statusCode).toBe(409);
  });

  it('auto: an unconfirmed link opens the data, but approving an action waits for the confirmation; "not this customer" returns the link', async () => {
    const { http, base, api, integration } = await setup({ claimLinking: 'auto' });
    const card = guest('anna').cardNumber;
    const ticketId = (await ingest(app, api, { external_id: 'a-1', customer: { name: 'Пётр', identities: { email: 'petr@example.test' } }, body: `Карта ${card}. Чек на 380 ₽ не провели по карте` })).json().ticket_id;
    const propose = toolCall('propose_accrue_points', {
      params: { basis: 'base_cashback', amount: 19, transaction_id: null, receipt_total: 380 },
      reason: 'Чек не провели по карте',
    });
    const llm = new ScriptedLlm([propose, submit()]);
    agent.setLlm(llm);
    await process(ticketId);

    expect(await prisma.customerLink.findFirstOrThrow()).toMatchObject({ status: 'found', customerRef: 'anna', source: 'claim', confirmed: false, pending: { kind: 'confirm' } });
    expect(userMessage(llm.requests[0]!)).toContain('Not confirmed by the operator yet');
    const [proposal] = (await http.get(`${base}/tickets/${ticketId}/agent`)).json().actions;
    const approve = await http.post(`${base}/tickets/${ticketId}/actions/${proposal.id}/approve`, {});
    expect(approve.statusCode).toBe(409);
    expect(approve.json().error.message).toContain('Confirm the customer first');

    const rejected = await http.post(`${base}/tickets/${ticketId}/customer-links/${integration.id}/decide`, { decision: 'reject' });
    expect(rejected.json()).toMatchObject({ status: 'not_found', customerRef: null, confirmed: true, pending: null, claims: [{ status: 'rejected' }] });
    expect(await prisma.ticketEvent.findFirst({ where: { ticketId, type: 'identification_rejected' } })).not.toBeNull();

    // A rejected value is not offered again for this customer.
    const next = (await ingest(app, api, { external_id: 'a-2', customer: { name: 'Пётр', identities: { email: 'petr@example.test' } }, body: `Ещё раз: карта ${card}` })).json().ticket_id;
    expect(await prisma.identityClaim.findFirstOrThrow({ where: { ticketId: next } })).toMatchObject({ status: 'rejected' });
  });

  it('a conflict: the sender is one guest, the card in the text is another — the operator chooses, actions wait until then', async () => {
    const { http, base, api, integration } = await setup({ claimLinking: 'auto' });
    const ticketId = (await ingest(app, api, { external_id: 'c-1', customer: { name: 'Анна', identities: { email: 'anna@example.test', phone: guest('anna').phone } }, body: `Начислите на карту ${guest('boris').cardNumber}` })).json().ticket_id;
    agent.setLlm(new ScriptedLlm([submit()]));
    await process(ticketId);

    const link = await prisma.customerLink.findFirstOrThrow();
    expect(link).toMatchObject({
      status: 'found',
      customerRef: 'anna',
      confirmed: false,
      pending: { kind: 'conflict', options: [{ customerRef: 'anna', current: true }, { customerRef: 'boris', current: false, matchedBy: ['card_number'] }] },
    });

    const decided = await http.post(`${base}/tickets/${ticketId}/customer-links/${integration.id}/decide`, { decision: 'choose', customerRef: 'boris' });
    expect(decided.json()).toMatchObject({ status: 'found', customerRef: 'boris', confirmed: true, source: 'manual' });
  });

  it('corroborated: a phone from a form and a card from the text point to one guest — linked right away', async () => {
    const { api } = await setup({ claimLinking: 'corroborated' });
    const anna = guest('anna');
    const ticketId = (
      await ingest(app, api, {
        external_id: 'k-1',
        customer: { name: 'Аня', identities: { email: 'new@example.test' }, unverified_identities: { phone: anna.phone } },
        body: `Карта ${anna.cardNumber}`,
      })
    ).json().ticket_id;
    const llm = new ScriptedLlm([submit()]);
    agent.setLlm(llm);
    await process(ticketId);

    expect(await prisma.customerLink.findFirstOrThrow()).toMatchObject({ status: 'found', customerRef: 'anna', confirmed: true, source: 'claim', pending: null });
    expect(new Set((await prisma.identityClaim.findMany({ where: { ticketId } })).map((c) => c.status))).toEqual(new Set(['confirmed']));
    expect(userMessage(llm.requests[0]!)).toContain('Found: Анна (identified by');
    expect(toolNames(llm.requests[0]!)).toContain('get_transactions');
  });

  it('identify_customer: a value from the text links the customer and opens their tools in the same run; a value not in the messages is refused', async () => {
    const { api } = await setup({ claimLinking: 'auto' });
    const card = guest('anna').cardNumber;
    const spaced = `${card.slice(0, 3)} ${card.slice(3, 6)} ${card.slice(6)}`;
    const ticketId = (await ingest(app, api, { external_id: 'i-1', customer: { name: 'Пётр', identities: { email: 'petr@example.test' } }, body: `Номер карты ${spaced}, баллы не пришли` })).json().ticket_id;
    const llm = new ScriptedLlm([
      toolCall('identify_customer', { identities: { card_number: guest('boris').cardNumber }, evidence: 'выдумано' }),
      toolCall('identify_customer', { identities: { card_number: card }, evidence: `Номер карты ${spaced}` }),
      submit(),
    ]);
    agent.setLlm(llm);
    await process(ticketId);

    expect(toolNames(llm.requests[0]!)).toContain('identify_customer');
    expect(toolNames(llm.requests[0]!)).not.toContain('get_transactions');
    expect(llm.requests[1]!.messages.at(-1)!.content).toMatch(/^Not accepted: card_number \d+ does not occur/);
    const linked = llm.requests[2]!.messages.at(-1)!.content as string;
    expect(linked).toContain('Customer linked without confirmation: Анна (matched by card_number)');
    expect(linked).toContain('<integration_data kind="customer_card">');
    expect(toolNames(llm.requests[2]!)).toEqual(expect.arrayContaining(['get_transactions', 'propose_accrue_points']));
    expect(toolNames(llm.requests[2]!).at(-1)).toBe('submit_result');
    expect(await prisma.identityClaim.findFirstOrThrow({ where: { ticketId } })).toMatchObject({ source: 'agent', value: card, status: 'matched' });
    expect(await prisma.customerLink.findFirstOrThrow()).toMatchObject({ customerRef: 'anna', confirmed: false });
  });

  it('customer fields from the card: mapped keys are written for a confirmed customer only, an operator\'s pin wins, a relink clears them', async () => {
    const { http, base, api, integration } = await setup({ claimLinking: 'auto' });
    await http.post(`${base}/fields`, { entity: 'customer', key: 'tier', label: 'Уровень', type: 'number' });
    await http.post(`${base}/fields`, { entity: 'customer', key: 'city', label: 'Город', type: 'text' });
    const patched = await http.patch(`${base}/integrations/${integration.id}`, { fieldMapping: { cashback_percent: 'tier' } });
    expect(patched.json()).toMatchObject({ fieldMapping: { cashback_percent: 'tier' }, claimLinking: 'auto', textIdentities: true });

    const found = (await ingest(app, api, { external_id: 'f-1', customer: { name: 'Анна', identities: { email: 'anna@example.test' } }, body: 'Баллы' })).json().ticket_id;
    agent.setLlm(new ScriptedLlm([submit()]));
    await process(found);
    const anna = await prisma.customer.findFirstOrThrow({ where: { tickets: { some: { id: found } } } });
    expect(anna.fields).toEqual({ tier: 5, city: guest('anna').city });
    expect(anna.fieldMeta).toMatchObject({ tier: { source: 'integration', integrationId: integration.id, customerRef: 'anna', locked: false } });

    // An unconfirmed customer (a card from the text under auto) gets nothing written.
    const unconfirmed = (await ingest(app, api, { external_id: 'f-2', customer: { name: 'Пётр', identities: { email: 'petr@example.test' } }, body: `Карта ${guest('boris').cardNumber}` })).json().ticket_id;
    agent.setLlm(new ScriptedLlm([submit()]));
    await process(unconfirmed);
    expect((await prisma.customer.findFirstOrThrow({ where: { tickets: { some: { id: unconfirmed } } } })).fields).toEqual({});

    // The operator pinned the tier; a relink to another guest clears only what the integration wrote.
    await prisma.customer.update({
      where: { id: anna.id },
      data: { fieldMeta: { ...(anna.fieldMeta as object), tier: { source: 'operator', locked: true, updatedAt: new Date().toISOString() } } },
    });
    const relinked = await http.post(`${base}/tickets/${found}/customer-links/${integration.id}`, { customerRef: 'boris' });
    expect(relinked.json()).toMatchObject({ outcome: 'found', link: { customerRef: 'boris' } });
    sim.store.guests.get('boris')!.city = 'Казань';
    agent.setLlm(new ScriptedLlm([submit()]));
    await process(found);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: anna.id } })).fields).toEqual({ tier: 5, city: 'Казань' });
  });
});
