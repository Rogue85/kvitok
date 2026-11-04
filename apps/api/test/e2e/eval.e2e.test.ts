import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createSimServer, ingestPayload, type SimServer } from '@kvitok/coffee-sim';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EvalRunner, type EvalRunOptions } from '../../src/eval/eval-runner';
import type { LlmClient } from '../../src/llm/llm.types';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp, resetDb, setupWorkspace } from '../helpers';
import { result, ScriptedLlm, toolCall } from '../support/scripted-llm';

const SECRET = 'eval-sim-secret';

describe('agent evaluation on scenarios', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let sim: SimServer;
  let simUrl: string;
  const llm: { client: LlmClient | null } = { client: null };

  beforeAll(async () => {
    app = await createTestApp({ llm: () => ({ chat: (request) => llm.client!.chat(request) }) });
    prisma = app.get(PrismaService);
    sim = createSimServer({ secret: SECRET, scenarios: ['app-login-code', 'receipt-not-on-card'], locale: 'ru' });
    simUrl = await sim.listen();
  });

  beforeEach(async () => {
    await resetDb(app);
  });

  afterAll(async () => {
    await sim.close();
    await app.close();
  });

  const options = (overrides: Partial<EvalRunOptions> = {}): EvalRunOptions => ({
    scenarios: sim.store.scenarios,
    sim: { url: simUrl, secret: SECRET, ingestPayload: (scenario) => ingestPayload(scenario, sim.store) },
    provider: { name: 'Test', baseUrl: 'http://llm.test/v1', apiKey: 'sk-test', model: 'm', inputPerMillion: 14, outputPerMillion: 68, currency: 'RUB' },
    concurrency: 1,
    ...overrides,
  });

  /** Scenarios run in order: app-login-code, then receipt-not-on-card. */
  const script = () =>
    new ScriptedLlm([
      toolCall('submit_result', result({ department: 'loyalty' })),
      toolCall('propose_accrue_points', { params: { basis: 'base_cashback', amount: 19, transaction_id: null, receipt_total: 380 }, reason: 'Чек не по карте' }),
      toolCall('submit_result', result({ department: 'loyalty' })),
    ]);

  it('runs scenarios through ingest and the agent and compares them with the expectation', async () => {
    llm.client = script();
    const progress: string[] = [];

    const report = await new EvalRunner(app).run(options({ onProgress: (score) => progress.push(score.scenario.id) }));

    expect(progress).toEqual(['app-login-code', 'receipt-not-on-card']);
    expect(report.summary).toMatchObject({
      scenarios: 2,
      passed: 1,
      department: { correct: 1, total: 2 },
      actions: { expected: 1, matched: 1, paramsExact: 1, proposed: 1, extra: 0 },
      forbidden: 0,
      failedRuns: 0,
      cost: { currency: 'RUB' },
    });
    expect(report.summary.cost.total).toBeGreaterThan(0);
    expect(report.config).toMatchObject({ model: 'm', provider: 'Test', source: 'env', configHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const [app_, receipt] = report.scores;
    expect(app_).toMatchObject({ departmentOk: false, passed: false, outcome: { department: 'loyalty', agentDepartment: 'loyalty' } });
    expect(receipt).toMatchObject({ passed: true, outcome: { tools: ['resolve_customer', 'get_customer_context', 'propose_accrue_points', 'submit_result'] } });
    // app-login-code expects the coffee shop field to stay empty: the evaluation creates a field bound to the directory.
    expect(app_!.optionSets).toEqual([{ set: 'places', expected: null, value: null, candidates: [], verdict: 'correct' }]);
    expect(report.summary.optionSets).toMatchObject({ total: 1, correct: 1 });

    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug: 'eval' }, include: { agentSettings: true } });
    expect(workspace.agentSettings).toMatchObject({ enabled: false, model: 'm' });
    expect(await prisma.ticket.count({ where: { workspaceId: workspace.id } })).toBe(2);
    const field = await prisma.fieldDefinition.findFirstOrThrow({ where: { workspaceId: workspace.id, key: 'places' }, include: { optionSet: true } });
    expect(field).toMatchObject({ type: 'select', fillMode: 'agent_suggest', optionSet: { name: 'places' } });
  });

  it('takes the configuration from --from: provider, policy, departments, members; the evaluation workspace is recreated; the budget stops the run', async () => {
    const { workspaceId, http, user } = await setupWorkspace(app);
    const base = `/workspaces/${workspaceId}`;
    const provider = (await http.post(`${base}/llm-providers`, { name: 'Источник', baseUrl: 'http://llm.test/v1', apiKey: 'sk-source', models: [{ id: 'src-model' }] })).json();
    await http.put(`${base}/agent/settings`, { enabled: true, providerId: provider.id, model: 'src-model', policy: 'Обращайся на «вы».' });
    await http.post(`${base}/departments`, { key: 'loyalty', title: 'Лояльность (наша)', description: 'Баллы' });
    const slug = (await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })).slug;

    llm.client = script();
    const first = await new EvalRunner(app).run(options({ provider: undefined, settingsFrom: slug }));
    llm.client = new ScriptedLlm([]);
    const second = await new EvalRunner(app).run(options({ provider: undefined, settingsFrom: slug, budget: 0 }));

    expect(first.config).toMatchObject({ model: 'src-model', provider: 'Источник', source: slug });
    expect(second.summary).toMatchObject({ scenarios: 2, skipped: 2, passed: 0 });
    const workspaces = await prisma.workspace.findMany({ where: { slug: { startsWith: 'eval' } }, include: { agentSettings: true, departments: true, memberships: true } });
    expect(workspaces).toHaveLength(1);
    const evalWorkspace = workspaces[0]!;
    expect(evalWorkspace.agentSettings).toMatchObject({ policy: 'Обращайся на «вы».', enabled: false });
    expect(evalWorkspace.departments.map((d) => [d.key, d.title]).sort()).toEqual([
      ['app', 'Приложение'],
      ['loyalty', 'Лояльность (наша)'],
    ]);
    expect(evalWorkspace.memberships.map((m) => m.userId)).toEqual([user.id]);
  });
});
