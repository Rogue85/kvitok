import { describe, expect, it } from 'vitest';
import { paramValueEquals, renderMarkdown, scoreScenario, summarize, type ScenarioExpectation, type ScenarioOutcome } from './compare';

const scenario = (overrides: Partial<ScenarioExpectation> = {}): ScenarioExpectation => ({
  id: 'receipt-not-on-card',
  title: 'Receipt not scanned with the card',
  tags: [],
  departments: ['loyalty'],
  actions: [{ type: 'accrue_points', params: { basis: 'base_cashback', amount: 19, transaction_id: null } }],
  forbidActions: ['issue_coupon'],
  ...overrides,
});

const outcome = (overrides: Partial<ScenarioOutcome> = {}): ScenarioOutcome => ({
  status: 'applied',
  error: null,
  department: 'loyalty',
  agentDepartment: 'loyalty',
  confidence: 0.9,
  needsHuman: false,
  summary: 'Receipt not on the card',
  actions: [{ type: 'accrue_points', params: { basis: 'base_cashback', amount: 19, transaction_id: null, receipt_total: 380 }, preview: null, reason: '' }],
  tools: ['get_transactions', 'propose_accrue_points', 'submit_result'],
  tokensIn: 1000,
  tokensOut: 100,
  cost: 0.3,
  currency: 'RUB',
  durationMs: 10_000,
  ...overrides,
});

describe('scenario evaluation', () => {
  it('numbers are compared by value, null and strings exactly', () => {
    expect(paramValueEquals(19, '19')).toBe(true);
    expect(paramValueEquals(19, 20)).toBe(false);
    expect(paramValueEquals(null, undefined)).toBe(true);
    expect(paramValueEquals('zoya-t1', 'zoya-t1')).toBe(true);
    expect(paramValueEquals(0, null)).toBe(false);
  });

  it('everything matched — passed; extra agent parameters do not matter', () => {
    const score = scoreScenario(scenario(), outcome());
    expect(score).toMatchObject({ departmentOk: true, passed: true, extra: [], forbidden: [] });
    expect(score.expected[0]).toMatchObject({ matched: true, paramsOk: true });
  });

  it('the same action with another amount — found by type, but the parameters differ', () => {
    const score = scoreScenario(scenario(), outcome({ actions: [{ type: 'accrue_points', params: { basis: 'base_cashback', amount: 38, transaction_id: null }, preview: null, reason: '' }] }));
    expect(score.expected[0]).toMatchObject({ matched: true, paramsOk: false, actual: { amount: 38 } });
    expect(score.passed).toBe(false);
  });

  it('an extra and a forbidden action, a wrong department, a run error — not passed', () => {
    const extra = scoreScenario(scenario(), outcome({ actions: [...outcome().actions, { type: 'issue_coupon', params: { promo_id: 'x' }, preview: null, reason: '' }] }));
    expect(extra).toMatchObject({ extra: [{ type: 'issue_coupon' }], forbidden: ['issue_coupon'], passed: false });
    expect(scoreScenario(scenario(), outcome({ department: 'triage' }))).toMatchObject({ departmentOk: false, passed: false });
    expect(scoreScenario(scenario(), outcome({ status: 'failed', error: 'timeout' })).passed).toBe(false);
  });

  it('there can be several acceptable departments', () => {
    expect(scoreScenario(scenario({ departments: ['loyalty', 'triage'] }), outcome({ department: 'triage' })).departmentOk).toBe(true);
    expect(scoreScenario(scenario({ departments: ['loyalty', 'triage'] }), outcome({ department: 'app' })).departmentOk).toBe(false);
  });

  it('a scenario without actions passes only if the agent proposed nothing', () => {
    const none = scenario({ actions: [], forbidActions: ['accrue_points'] });
    expect(scoreScenario(none, outcome({ actions: [] })).passed).toBe(true);
    expect(scoreScenario(none, outcome()).passed).toBe(false);
  });

  it('repeats: stable and flaky scenarios, the share in the scenario row', () => {
    const scores = [
      scoreScenario(scenario(), outcome(), 1),
      scoreScenario(scenario({ id: 'flaky' }), outcome(), 1),
      scoreScenario(scenario(), outcome(), 2),
      scoreScenario(scenario({ id: 'flaky' }), outcome({ actions: [] }), 2),
    ];
    const summary = summarize(scores);
    expect(summary).toMatchObject({ scenarios: 2, runs: 4, passed: 3, stable: 1, flaky: 1 });
    const markdown = renderMarkdown({
      startedAt: '2026-10-31T11:00:00.000Z',
      finishedAt: '2026-10-31T11:01:00.000Z',
      config: { model: 'm', provider: 'p', configHash: null, corePromptVersion: 6, source: 'x' },
      summary,
      scores,
    });
    expect(markdown).toContain('| Scenarios stable (in every repeat) | 1 / 2 (50%); flaky: 1 |');
    expect(markdown).toContain('| flaky | ✓ loyalty | ✗ accrue_points (missing) | ≈ 1/2 |');
    expect(markdown).toContain('### flaky (repeat 2)');
  });

  it('summary and report: rates, cost, analysis of mismatches', () => {
    const scores = [
      scoreScenario(scenario(), outcome()),
      scoreScenario(scenario({ id: 'app-login-code', title: 'Code', departments: ['app'], actions: [] }), outcome({ department: 'loyalty', actions: [] })),
      scoreScenario(scenario({ id: 'skipped' }), outcome({ status: 'skipped', tokensIn: 0, tokensOut: 0, cost: null, durationMs: 0 })),
    ];
    const summary = summarize(scores);
    expect(summary).toMatchObject({
      scenarios: 3,
      runs: 3,
      passed: 1,
      department: { correct: 1, total: 2 },
      actions: { expected: 1, matched: 1, paramsExact: 1, proposed: 1, extra: 0 },
      skipped: 1,
      cost: { total: 0.6, currency: 'RUB' },
      durationMs: { average: 10_000 },
    });

    const markdown = renderMarkdown({
      startedAt: '2026-10-31T11:00:00.000Z',
      finishedAt: '2026-10-31T11:01:00.000Z',
      config: { model: 'haiku-5.5', provider: 'Example', configHash: 'abcdef0123456789', corePromptVersion: 6, source: 'coffee-sim', locale: 'ru' },
      summary,
      scores,
    });
    expect(markdown).toContain('settings from "coffee-sim" · scenarios: ru');
    expect(markdown).toContain('| Runs passed completely | 1 / 3 (33%) |');
    expect(markdown).toContain('| app-login-code | ✗ app → loyalty | — | ✗ |');
    expect(markdown).toContain('### app-login-code — Code');
    expect(markdown).toContain('| skipped | — | ✓ accrue_points | skipped |');
  });
});
