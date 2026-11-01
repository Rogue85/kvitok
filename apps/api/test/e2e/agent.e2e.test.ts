import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_QUEUE } from '../../src/agent/agent.constants';
import { ConfigSnapshotService } from '../../src/agent/config-snapshot.service';
import type { LlmClient } from '../../src/llm/llm.types';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RealtimeService } from '../../src/realtime/realtime.service';
import { createAgentHarness, type AgentHarness } from '../agent-harness';
import { createApiChannel, createTestApp, createUser, ingest, resetDb, setupWorkspace, type TestApiChannel } from '../helpers';
import { result, ScriptedLlm, toolCall } from '../support/scripted-llm';

describe('agent', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let agent: AgentHarness;
  let queue: Queue;
  const appLlm: { client: LlmClient | null } = { client: null };

  beforeAll(async () => {
    app = await createTestApp({ llm: () => ({ chat: (request) => appLlm.client!.chat(request) }) });
    prisma = app.get(PrismaService);
    agent = await createAgentHarness();
    queue = app.get<Queue>(getQueueToken(AGENT_QUEUE));
  });

  beforeEach(async () => {
    await resetDb(app);
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await agent.context.close();
    await app.close();
  });

  async function setup(options: { enabled?: boolean } = {}) {
    const ctx = await setupWorkspace(app);
    const base = `/workspaces/${ctx.workspaceId}`;
    const dept = async (body: object) => (await ctx.http.post(`${base}/departments`, body)).json();
    const departments = {
      general: await dept({ key: 'general', title: 'Общая', isTriage: true }),
      loyalty: await dept({ key: 'loyalty', title: 'Лояльность', description: 'бонусы и купоны' }),
      it: await dept({ key: 'it', title: 'ИТ' }),
    };
    const field = (body: object) => ctx.http.post(`${base}/fields`, { entity: 'ticket', ...body });
    await field({ key: 'receipt_number', label: 'Номер чека', type: 'text', fillMode: 'agent_auto', agentMinConfidence: 0.8 });
    await field({ key: 'store', label: 'Кофейня', type: 'text', fillMode: 'agent_suggest' });
    await field({ key: 'dept_number', label: 'Номер отдела', type: 'number', fillMode: 'agent_auto' });
    await ctx.http.post(`${base}/playbooks`, { key: 'missing_points', title: 'Не начислены баллы', when: 'жалоба на баллы', body: 'Попроси номер чека.' });
    const provider = (
      await ctx.http.post(`${base}/llm-providers`, {
        name: 'Test',
        baseUrl: 'http://llm.test/v1',
        apiKey: 'sk-test',
        models: [{ id: 'test-model', inputPerMillion: 2, outputPerMillion: 8 }],
      })
    ).json();
    const put = (body: object) => ctx.http.put(`${base}/agent/settings`, body);
    const enabled = await put({ enabled: options.enabled ?? true, providerId: provider.id, model: 'test-model', debounceSeconds: 30 });
    if (enabled.statusCode !== 200) throw new Error(enabled.body);
    const channel = await createApiChannel(ctx.http, ctx.workspaceId);
    return { ...ctx, base, departments, provider, channel, put };
  }

  async function createMailboxFor(http: { post: (url: string, payload: object) => Promise<unknown> }, base: string) {
    await http.post(`${base}/channels`, {
      type: 'email',
      name: 'Поддержка',
      address: 'support@example.com',
      smtp: { host: 'smtp.example.com', port: 465, user: 'support@example.com', password: 'smtp-pass' },
    });
  }

  async function processQueued(ticketId: string) {
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    if (!ticket.agentJobId) throw new Error(`Ticket is not queued (state ${ticket.agentState})`);
    return agent.engine.processTicket(ticketId, ticket.agentJobId);
  }

  async function newTicket(channel: TestApiChannel, body: Record<string, unknown> = {}) {
    return (await ingest(app, channel, { body: 'Купил кофе по чеку 0548 в кофейне на Тверской, баллы не пришли', ...body })).json();
  }

  it('a new ticket: analysis, department, field, suggestion, draft, question, cost and steps', async () => {
    const { channel, departments, http, base } = await setup();
    const created = await newTicket(channel);

    const queued = await prisma.ticket.findUniqueOrThrow({ where: { id: created.ticket_id } });
    expect(queued).toMatchObject({ agentState: 'queued', agentPending: { mode: 'triage', triggers: [{ type: 'ticket_created' }] } });
    expect(await queue.getJob(queued.agentJobId!)).toBeTruthy();

    agent.setLlm(
      new ScriptedLlm([
        toolCall('read_playbook', { key: 'missing_points' }, { input: 1000, output: 50 }),
        toolCall(
          'submit_result',
          result({
            department: 'loyalty',
            confidence: 0.92,
            fields: {
              receipt_number: { value: '0548', confidence: 0.95, evidence: 'по чеку 0548' },
              store: { value: 'Тверская', confidence: 0.9, evidence: 'в кофейне на Тверской' },
            },
            questions_for_operator: ['Есть ли доступ к кассе Тверской?'],
            playbooks_used: ['missing_points'],
          }),
          { input: 1500, output: 300 },
        ),
      ]),
    );

    await expect(processQueued(created.ticket_id)).resolves.toBe('applied');

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: created.ticket_id }, include: { events: true, drafts: true, agentQuestions: true } });
    expect(ticket).toMatchObject({
      agentState: 'idle',
      departmentId: departments.loyalty.id,
      departmentLocked: false,
      fields: { receipt_number: '0548' },
      fieldMeta: { receipt_number: { source: 'agent', confidence: 0.95, evidence: 'по чеку 0548', locked: false } },
      analysis: {
        department: 'loyalty',
        sentToTriage: false,
        summary: 'Клиент не получил баллы за покупку',
        fieldSuggestions: { store: { value: 'Тверская', reason: 'suggest_mode' } },
      },
    });
    expect(ticket.drafts).toEqual([expect.objectContaining({ source: 'agent', status: 'current', bodyHtml: '<p>Добрый день!</p><p>Проверим и вернёмся с ответом.</p>' })]);
    expect(ticket.agentQuestions).toEqual([expect.objectContaining({ text: 'Есть ли доступ к кассе Тверской?', status: 'open' })]);
    expect(ticket.events.map((e) => e.type)).toEqual(expect.arrayContaining(['department_changed', 'field_changed', 'agent_analyzed']));
    expect(ticket.revision).toBe(1);

    const run = await prisma.agentRun.findFirstOrThrow({ include: { steps: { orderBy: { index: 'asc' } }, configVersion: true } });
    expect(run).toMatchObject({ status: 'applied', mode: 'triage', tokensIn: 2500, tokensOut: 350, cost: 0.0078, model: 'test-model' });
    expect(run.steps.map((s) => `${s.kind}:${s.name}`)).toEqual(['llm:test-model', 'tool:read_playbook', 'llm:test-model', 'tool:submit_result']);
    expect(run.configVersion?.number).toBe(1);

    const { cost } = (await http.get(`${base}/tickets/${created.ticket_id}/agent`)).json();
    expect(cost).toEqual({
      currency: 'USD',
      usage: { runs: 1, tokensIn: 2500, tokensOut: 350, cost: 0.0078, unpricedRuns: 0 },
      dryRuns: { runs: 0, tokensIn: 0, tokensOut: 0, cost: 0, unpricedRuns: 0 },
    });
  });

  it('low confidence or needs_human — to the triage department', async () => {
    const { channel, departments } = await setup();
    const created = await newTicket(channel);
    agent.setLlm(new ScriptedLlm([toolCall('submit_result', result({ department: 'it', confidence: 0.3 }))]));

    await processQueued(created.ticket_id);

    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: created.ticket_id } })).toMatchObject({
      departmentId: departments.general.id,
      analysis: { department: 'it', sentToTriage: true },
    });
  });

  it('needs_human with a confident department does not reset routing — it only highlights the ticket', async () => {
    const { channel, departments } = await setup();
    const created = await newTicket(channel);
    agent.setLlm(new ScriptedLlm([toolCall('submit_result', result({ department: 'loyalty', confidence: 0.9, needs_human: true }))]));

    await processQueued(created.ticket_id);

    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: created.ticket_id } })).toMatchObject({
      departmentId: departments.loyalty.id,
      analysis: { needsHuman: true, sentToTriage: false },
    });
  });

  it('the agent does not change a department pinned by an operator — it leaves a suggestion; the operator accepts it', async () => {
    const { channel, departments, http, base } = await setup();
    const created = await newTicket(channel);
    await http.patch(`${base}/tickets/${created.ticket_id}`, { departmentId: departments.it.id });
    await prisma.ticket.update({ where: { id: created.ticket_id }, data: { revision: 1 } });
    agent.setLlm(new ScriptedLlm([toolCall('submit_result', result({ department: 'loyalty', confidence: 0.9 }))]));

    const outcome = await processQueued(created.ticket_id);

    expect(outcome).toBe('applied');
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: created.ticket_id } });
    expect(ticket.departmentId).toBe(departments.it.id);
    expect(ticket.analysis).toMatchObject({ departmentSuggestion: { departmentId: departments.loyalty.id } });

    const accepted = await http.post(`${base}/tickets/${created.ticket_id}/agent/suggestions/accept`, { kind: 'department' });
    expect(accepted.statusCode).toBe(204);
    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: created.ticket_id } });
    expect(after).toMatchObject({ departmentId: departments.loyalty.id, departmentLocked: true, analysis: { departmentSuggestion: null } });
  });

  it('if the ticket changed during the run — the result is not applied and the run restarts', async () => {
    const { channel } = await setup();
    const created = await newTicket(channel);
    agent.setLlm(
      new ScriptedLlm([
        async () => {
          await prisma.ticket.update({ where: { id: created.ticket_id }, data: { revision: { increment: 1 } } });
          return toolCall('submit_result', result({ department: 'loyalty' }));
        },
      ]),
    );

    await expect(processQueued(created.ticket_id)).resolves.toBe('stale');

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: created.ticket_id } });
    expect(ticket).toMatchObject({ departmentId: null, analysis: null, agentState: 'queued', agentPending: { triggers: [{ type: 'stale_rerun' }] } });
    expect((await prisma.agentRun.findFirstOrThrow()).status).toBe('stale');

    agent.setLlm(new ScriptedLlm([toolCall('submit_result', result({ department: 'loyalty' }))]));
    await expect(processQueued(created.ticket_id)).resolves.toBe('applied');
  });

  it('a message to the agent: a partial run — a reply to the operator, a new draft over the edits, the analysis is kept', async () => {
    const { channel, http, base, departments } = await setup();
    const created = await newTicket(channel);
    agent.setLlm(new ScriptedLlm([toolCall('submit_result', result({ department: 'loyalty', findings: ['Чек 0548'], questions_for_operator: ['Карту прикладывал?'] }))]));
    await processQueued(created.ticket_id);
    const url = `${base}/tickets/${created.ticket_id}`;
    await http.put(`${url}/draft`, { bodyHtml: '<p>Моя правка</p>' });

    await http.post(`${url}/agent/messages`, { body: 'Не начисляй баллы, предложи купон' });
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: created.ticket_id } })).toMatchObject({
      agentState: 'queued',
      agentPending: { mode: 'refine', triggers: [{ type: 'operator_message' }] },
    });

    const llm = new ScriptedLlm([
      toolCall('submit_result', { message_to_operator: 'Понял, заменил баллы на купон в ответе.', reply: { needed: true, body: 'Предлагаем купон' } }),
    ]);
    agent.setLlm(llm);
    await expect(processQueued(created.ticket_id)).resolves.toBe('applied');

    const user = llm.requests[0]!.messages[1]!.content as string;
    expect(user).toMatch(/## Task\nThe operator wrote to you[\s\S]*Не начисляй баллы, предложи купон/);
    expect(user).toContain('## Your previous analysis');
    expect(user).toContain('## Current draft reply to the customer (edited by the operator)\nМоя правка');

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: created.ticket_id }, include: { events: { orderBy: { createdAt: 'asc' } } } });
    expect(ticket.departmentId).toBe(departments.loyalty.id);
    expect(ticket.analysis).toMatchObject({ department: 'loyalty', summary: 'Клиент не получил баллы за покупку', findings: ['Чек 0548'] });
    expect(ticket.events.filter((e) => e.type === 'agent_analyzed').at(-1)?.data).toMatchObject({
      mode: 'refine',
      message: 'Понял, заменил баллы на купон в ответе.',
      analysisUpdated: false,
      replyUpdated: true,
      questions: [],
    });
    const state = (await http.get(`${url}/agent`)).json();
    expect(state.draft).toMatchObject({ source: 'agent', bodyHtml: '<p>Предлагаем купон</p>' });
    expect(state.suggestedDraft).toBeNull();
    expect(state.questions).toMatchObject([{ text: 'Карту прикладывал?' }]);
  });

  it('operator messages from a cancelled run carry over to the next one', async () => {
    const { channel, http, base } = await setup();
    const created = await newTicket(channel);
    agent.setLlm(new ScriptedLlm([toolCall('submit_result', result())]));
    await processQueued(created.ticket_id);
    const url = `${base}/tickets/${created.ticket_id}`;
    const first = (await http.post(`${url}/agent/messages`, { body: 'Чек 0548' })).json();

    let release!: () => void;
    const started = new Promise<void>((resolve) => (release = resolve));
    agent.setLlm(
      new ScriptedLlm([
        (request) =>
          new Promise((_, reject) => {
            release();
            request.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ]),
    );
    const running = processQueued(created.ticket_id);
    await started;
    const second = (await http.post(`${url}/agent/messages`, { body: 'И сделай короче' })).json();
    await expect(running).resolves.toBe('cancelled');

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: created.ticket_id } });
    expect(ticket.agentPending).toMatchObject({
      mode: 'refine',
      triggers: [
        { type: 'operator_message', messageId: first.id },
        { type: 'operator_message', messageId: second.id },
      ],
    });
  });

  it('a message to the agent during a run cancels it, and a new one starts right away', async () => {
    const { channel, http, base } = await setup();
    const created = await newTicket(channel);
    let release!: () => void;
    const started = new Promise<void>((resolve) => (release = resolve));
    agent.setLlm(
      new ScriptedLlm([
        (request) =>
          new Promise((_, reject) => {
            release();
            request.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ]),
    );

    const running = processQueued(created.ticket_id);
    await started;
    await http.post(`${base}/tickets/${created.ticket_id}/agent/messages`, { body: 'Чек 0548' });

    await expect(running).resolves.toBe('cancelled');
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: created.ticket_id } });
    expect(ticket).toMatchObject({ agentState: 'queued', agentPending: { mode: 'refine' } });
    expect((await prisma.agentRun.findFirstOrThrow()).status).toBe('cancelled');
  });

  it('a second customer message while the run waits in the queue joins the same run', async () => {
    const { channel } = await setup();
    const created = await newTicket(channel, { conversation_external_id: 'chat-1' });
    const jobId = (await prisma.ticket.findUniqueOrThrow({ where: { id: created.ticket_id } })).agentJobId;

    await newTicket(channel, { conversation_external_id: 'chat-1', body: 'И ещё: купон тоже не пришёл' });

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: created.ticket_id } });
    expect(ticket.agentJobId).toBe(jobId);
    expect((ticket.agentPending as { triggers: unknown[] }).triggers).toHaveLength(2);
    expect(await queue.getJobCounts('waiting', 'delayed')).toMatchObject({ waiting: 1, delayed: 0 });
  });

  it('draft: an operator edit is not overwritten by a new agent version; accepting a version; sending closes the draft', async () => {
    const { channel, http, base } = await setup();
    await createMailboxFor(http, base);
    const created = await newTicket(channel);
    agent.setLlm(new ScriptedLlm([toolCall('submit_result', result())]));
    await processQueued(created.ticket_id);
    const url = `${base}/tickets/${created.ticket_id}`;

    const operatorDraft = (await http.put(`${url}/draft`, { bodyHtml: '<p>Моя версия</p>' })).json();
    expect(operatorDraft).toMatchObject({ source: 'operator', status: 'current' });
    await http.post(`${url}/agent/run`, { mode: 'refine' });

    agent.setLlm(new ScriptedLlm([toolCall('submit_result', result({ reply: { needed: true, body: 'Версия агента 2' } }))]));
    await processQueued(created.ticket_id);
    let state = (await http.get(`${url}/agent`)).json();
    expect(state.draft).toMatchObject({ source: 'operator', bodyHtml: '<p>Моя версия</p>' });
    expect(state.suggestedDraft).toMatchObject({ source: 'agent', bodyHtml: '<p>Версия агента 2</p>' });

    await http.post(`${url}/drafts/${state.suggestedDraft.id}/accept`);
    state = (await http.get(`${url}/agent`)).json();
    expect(state.draft).toMatchObject({ source: 'agent', bodyHtml: '<p>Версия агента 2</p>' });
    expect(state.suggestedDraft).toBeNull();

    const reply = await http.post(`${url}/replies`, { bodyHtml: state.draft.bodyHtml, via: ['email'] });
    expect(reply.statusCode).toBe(201);
    const statuses = (await prisma.replyDraft.findMany({ where: { ticketId: created.ticket_id }, orderBy: { version: 'asc' } })).map((d) => d.status);
    expect(statuses).toEqual(['superseded', 'superseded', 'sent']);
  });

  it('an answer to the agent\'s question — a message to the agent with a link and a refinement run', async () => {
    const { channel, http, base } = await setup();
    const created = await newTicket(channel);
    agent.setLlm(new ScriptedLlm([toolCall('submit_result', result({ questions_for_operator: ['Какая сумма чека?'] }))]));
    await processQueued(created.ticket_id);
    const question = await prisma.agentQuestion.findFirstOrThrow();

    const answer = await http.post(`${base}/tickets/${created.ticket_id}/agent/questions/${question.id}/answer`, { body: '540 ₽' });

    expect(answer.statusCode).toBe(201);
    expect(await prisma.agentQuestion.findUniqueOrThrow({ where: { id: question.id } })).toMatchObject({ status: 'answered', answerMessageId: answer.json().id });
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: created.ticket_id } });
    expect(ticket.agentPending).toMatchObject({ mode: 'refine', triggers: [{ type: 'question_answer', messageId: answer.json().id }] });

    const llm = new ScriptedLlm([toolCall('submit_result', result())]);
    agent.setLlm(llm);
    await processQueued(created.ticket_id);
    expect(llm.requests[0]!.messages[1]!.content).toContain('answers_question="Какая сумма чека?"');
  });

  it('questions on a rerun: closed ones stay in the context, a repeated open one is kept, not asked anew', async () => {
    const { channel, http, base } = await setup();
    const created = await newTicket(channel);
    const url = `${base}/tickets/${created.ticket_id}`;
    agent.setLlm(new ScriptedLlm([toolCall('submit_result', result({ questions_for_operator: ['Какая сумма чека?', 'Карту прикладывал?'] }))]));
    await processQueued(created.ticket_id);
    const amount = await prisma.agentQuestion.findFirstOrThrow({ where: { text: 'Какая сумма чека?' } });
    const card = await prisma.agentQuestion.findFirstOrThrow({ where: { text: 'Карту прикладывал?' } });
    await http.post(`${url}/agent/questions/${card.id}/dismiss`);

    const llm = new ScriptedLlm([toolCall('submit_result', result({ questions_for_operator: ['какая сумма чека', 'Какая сумма чека?', 'Где была покупка?'] }))]);
    agent.setLlm(llm);
    await http.post(`${url}/agent/run`, { mode: 'refine' });
    await processQueued(created.ticket_id);

    const context = llm.requests[0]!.messages[1]!.content as string;
    expect(context).toContain('status="open">Какая сумма чека?</agent_question>');
    expect(context).toContain('status="closed without an answer">Карту прикладывал?</agent_question>');
    const questions = await prisma.agentQuestion.findMany();
    expect(Object.fromEntries(questions.map((q) => [q.text, q.status]))).toEqual({
      'Какая сумма чека?': 'open',
      'Карту прикладывал?': 'dismissed',
      'Где была покупка?': 'open',
    });
    expect(questions.find((q) => q.text === 'Какая сумма чека?')!.id).toBe(amount.id);
    const event = await prisma.ticketEvent.findFirstOrThrow({ where: { ticketId: created.ticket_id, type: 'agent_analyzed' }, orderBy: { createdAt: 'desc' } });
    expect((event.data as { questions: Array<{ text: string }> }).questions.map((q) => q.text)).toEqual(['Где была покупка?']);
  });

  it('a model error: the run fails, an event in the ticket, the state is failed', async () => {
    const { channel } = await setup();
    const created = await newTicket(channel);
    agent.setLlm(new ScriptedLlm([() => Promise.reject(new Error('LLM HTTP 401: invalid key'))]));

    await expect(processQueued(created.ticket_id)).resolves.toBe('failed');

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: created.ticket_id }, include: { events: true } });
    expect(ticket.agentState).toBe('failed');
    expect(ticket.events.find((e) => e.type === 'agent_failed')?.data).toMatchObject({ error: 'LLM HTTP 401: invalid key' });
  });

  it('a run that fails after calling the model keeps the tokens it spent and their cost', async () => {
    const { channel } = await setup();
    const created = await newTicket(channel);
    agent.setLlm(
      new ScriptedLlm([toolCall('read_playbook', { key: 'missing_points' }, { input: 1000, output: 50 }), () => Promise.reject(new Error('LLM HTTP 500'))]),
    );

    await expect(processQueued(created.ticket_id)).resolves.toBe('failed');

    const run = await prisma.agentRun.findFirstOrThrow({ where: { ticketId: created.ticket_id } });
    expect(run).toMatchObject({ status: 'failed', tokensIn: 1000, tokensOut: 50, cost: 0.0024 });
  });

  it('an error before the run is created: the ticket does not get stuck in running', async () => {
    const { channel } = await setup();
    const created = await newTicket(channel);
    const resolve = vi.spyOn(agent.context.get(ConfigSnapshotService), 'resolve').mockRejectedValueOnce(new Error('column does not exist'));

    await expect(processQueued(created.ticket_id)).resolves.toBe('failed');
    resolve.mockRestore();

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: created.ticket_id }, include: { events: true } });
    expect(ticket.agentState).toBe('failed');
    expect(ticket.events.find((e) => e.type === 'agent_failed')?.data).toMatchObject({ error: 'column does not exist' });
  });

  it('the agent is disabled — no runs are queued', async () => {
    const { channel } = await setup({ enabled: false });
    const created = await newTicket(channel);

    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: created.ticket_id } })).toMatchObject({ agentState: 'idle', agentJobId: null });
  });

  describe('routing rules', () => {
    it('on_ingest: a field from a regular expression, a department and turning the agent off; a manual run still works', async () => {
      const { channel, http, base, departments } = await setup();
      await http.post(`${base}/routing-rules`, {
        name: 'Отдел из темы',
        stage: 'on_ingest',
        conditions: { field: 'subject', op: 'matches', value: '\\[DEP-\\d{3}\\]' },
        effects: [
          { type: 'set_field_from_regex', key: 'dept_number', source: 'subject', pattern: '\\[DEP-(\\d{3})\\]' },
          { type: 'set_department', departmentKey: 'it' },
          { type: 'add_tags', tags: ['internal'] },
          { type: 'skip_agent' },
        ],
      });

      const created = await newTicket(channel, { subject: '[DEP-214] Принтер' });

      const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: created.ticket_id }, include: { events: true } });
      expect(ticket).toMatchObject({
        fields: { dept_number: 214 },
        fieldMeta: { dept_number: { source: 'rule' } },
        departmentId: departments.it.id,
        departmentLocked: false,
        tags: ['internal'],
        agentSkipped: true,
        agentState: 'idle',
      });
      expect(ticket.events.filter((e) => e.actorType === 'rule').map((e) => e.type).sort()).toEqual(['department_changed', 'field_changed', 'tags_changed']);

      expect((await http.post(`${base}/tickets/${created.ticket_id}/agent/run`, { mode: 'triage' })).statusCode).toBe(202);
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: created.ticket_id } })).agentState).toBe('queued');
    });

    it('after_agent: a rule on the agent output and a field', async () => {
      const { channel, http, base, departments } = await setup();
      await http.post(`${base}/routing-rules`, {
        name: 'Склад по номеру отдела',
        stage: 'after_agent',
        conditions: { all: [{ field: 'fields.dept_number', op: 'between', value: [200, 299] }, { field: 'agent.needs_human', op: 'eq', value: false }] },
        effects: [{ type: 'set_department', departmentKey: 'it' }, { type: 'set_priority', priority: 'high' }],
      });
      const created = await newTicket(channel);
      agent.setLlm(
        new ScriptedLlm([
          toolCall('submit_result', result({ department: 'loyalty', fields: { dept_number: { value: 214, confidence: 0.99, evidence: 'отдел 214' } } })),
        ]),
      );

      await processQueued(created.ticket_id);

      expect(await prisma.ticket.findUniqueOrThrow({ where: { id: created.ticket_id } })).toMatchObject({
        departmentId: departments.it.id,
        priority: 'high',
        fields: { dept_number: 214 },
      });
    });

    it('a move by the agent or a rule reaches both departments, and an assignee who cannot see the new one is unassigned', async () => {
      const { channel, http, base, workspaceId, departments } = await setup();
      await http.post(`${base}/routing-rules`, {
        name: 'Склад по номеру отдела',
        stage: 'after_agent',
        conditions: { field: 'fields.dept_number', op: 'between', value: [200, 299] },
        effects: [{ type: 'set_department', departmentKey: 'it' }],
      });
      const operator = await createUser(app);
      await http.post(`${base}/members`, { userId: operator.id, role: 'operator', departments: { allDepartments: false, departmentIds: [departments.loyalty.id] } });
      const created = await newTicket(channel);
      // Routed but not pinned by an operator, so the rule may move it.
      await prisma.ticket.update({ where: { id: created.ticket_id }, data: { departmentId: departments.loyalty.id } });
      await http.patch(`${base}/tickets/${created.ticket_id}`, { assigneeId: operator.id });
      await http.post(`${base}/tickets/${created.ticket_id}/agent/run`, { mode: 'refine' });
      agent.setLlm(new ScriptedLlm([toolCall('submit_result', result({ department: 'loyalty', fields: { dept_number: { value: 214, confidence: 0.99, evidence: 'отдел 214' } } }))]));
      const publish = vi.spyOn(agent.context.get(RealtimeService), 'publish');

      await processQueued(created.ticket_id);

      expect(await prisma.ticket.findUniqueOrThrow({ where: { id: created.ticket_id } })).toMatchObject({ departmentId: departments.it.id, assigneeId: null });
      expect(publish).toHaveBeenCalledWith(workspaceId, { type: 'ticket.moved', ticketId: created.ticket_id, from: departments.loyalty.id, to: departments.it.id });
      expect(await prisma.ticketEvent.findFirst({ where: { ticketId: created.ticket_id, type: 'assignee_changed', actorType: 'rule' } })).toMatchObject({
        data: { from: operator.id, to: null, reason: 'department_access', departmentId: departments.it.id, rule: 'Склад по номеру отдела', stage: 'after_agent' },
      });
      publish.mockRestore();
    });

    it('checking rules on a ticket shows matches without applying them', async () => {
      const { channel, http, base } = await setup();
      await http.post(`${base}/routing-rules`, {
        name: 'Баллы',
        stage: 'on_ingest',
        conditions: { field: 'body', op: 'contains', value: 'баллы' },
        effects: [{ type: 'add_tags', tags: ['bonus'] }],
      });
      const created = await newTicket(channel, { body: 'Где мои купоны?' });
      await prisma.message.updateMany({ where: { ticketId: created.ticket_id }, data: { bodyText: 'баллы не пришли', bodyClean: 'баллы не пришли' } });

      const test = (await http.post(`${base}/routing-rules/test`, { ticketId: created.ticket_id })).json();

      expect(test[0]).toMatchObject({ stage: 'on_ingest', matched: [{ name: 'Баллы' }] });
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: created.ticket_id } })).tags).toEqual([]);
    });
  });

  describe('settings and versions', () => {
    it('the agent cannot be enabled without a provider and a model; the provider key is not returned', async () => {
      const { put, http, base } = await setup({ enabled: false });

      expect((await put({ enabled: true, providerId: null })).statusCode).toBe(422);
      expect(JSON.stringify((await http.get(`${base}/llm-providers`)).json())).not.toContain('sk-test');
    });

    it('the configuration version changes only when the configuration changes', async () => {
      const { channel, http, base } = await setup();
      const run = async () => {
        const created = await newTicket(channel);
        agent.setLlm(new ScriptedLlm([toolCall('submit_result', result())]));
        await processQueued(created.ticket_id);
        return (await prisma.agentRun.findFirstOrThrow({ where: { ticketId: created.ticket_id }, include: { configVersion: true } })).configVersion!.number;
      };

      expect(await run()).toBe(1);
      expect(await run()).toBe(1);
      const playbook = (await http.get(`${base}/playbooks`)).json()[0];
      await http.patch(`${base}/playbooks/${playbook.id}`, { body: 'Попроси номер и сумму чека.' });
      expect(await run()).toBe(2);
    });

    it('prompt preview and a trial run without applying', async () => {
      const { channel, http, base } = await setup();
      const created = await newTicket(channel);

      const preview = (await http.get(`${base}/tickets/${created.ticket_id}/agent/prompt-preview`)).json();
      expect(preview.messages[0].content).toContain('## Departments');
      expect(preview.tools.map((t: { name: string }) => t.name)).toEqual(['read_playbook', 'submit_result']);

      appLlm.client = new ScriptedLlm([toolCall('submit_result', result({ department: 'loyalty' }))]);
      const dry = await http.post(`${base}/tickets/${created.ticket_id}/agent/dry-run`);
      expect(dry.statusCode).toBe(200);
      expect(dry.json()).toMatchObject({ result: { department: 'loyalty' }, run: { dryRun: true, status: 'applied', steps: [{ kind: 'llm' }, { kind: 'tool' }] } });
      expect(await prisma.ticket.findUniqueOrThrow({ where: { id: created.ticket_id } })).toMatchObject({ departmentId: null, analysis: null });
      // A trial run is the cost of tuning the agent, not of the ticket.
      const { cost } = (await http.get(`${base}/tickets/${created.ticket_id}/agent`)).json();
      expect(cost).toMatchObject({ usage: { runs: 0, cost: 0 }, dryRuns: { runs: 1, cost: 0.00036 } });
    });
  });
});
