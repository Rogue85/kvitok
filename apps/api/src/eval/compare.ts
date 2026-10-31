/**
 * Agent evaluation on scenarios: comparing run outcomes with the scenario expectation, a summary and a report.
 * Pure functions only — unit tests cover them; the run lives in eval-runner.
 */

export interface ScenarioExpectation {
  id: string;
  title: string;
  tags: string[];
  /** Acceptable departments: usually one. */
  departments: string[];
  actions: Array<{ type: string; params: Record<string, unknown> }>;
  forbidActions: string[];
  needsHuman?: boolean;
  note?: string;
}

/** What the agent did on the scenario ticket. */
export interface ScenarioOutcome {
  status: 'applied' | 'stale' | 'failed' | 'cancelled' | 'skipped';
  error: string | null;
  /** Ticket department after routing (taking the confidence threshold and the triage department into account). */
  department: string | null;
  /** What the agent itself chose. */
  agentDepartment: string | null;
  confidence: number | null;
  needsHuman: boolean | null;
  summary: string | null;
  actions: Array<{ type: string; params: Record<string, unknown>; preview: string | null; reason: string }>;
  tools: string[];
  tokensIn: number;
  tokensOut: number;
  cost: number | null;
  currency: string | null;
  durationMs: number;
}

export interface ScenarioScore {
  scenario: ScenarioExpectation;
  /** Repeat number (from 1): the model is nondeterministic, a scenario may run several times. */
  attempt: number;
  outcome: ScenarioOutcome;
  departmentOk: boolean;
  /** Expected actions: whether an action of the same type was found and whether the parameters matched. */
  expected: Array<{ type: string; params: Record<string, unknown>; matched: boolean; paramsOk: boolean; actual: Record<string, unknown> | null }>;
  /** Proposed actions that are not in the expectation. */
  extra: Array<{ type: string; params: Record<string, unknown> }>;
  /** Forbidden actions that were proposed. */
  forbidden: string[];
  needsHumanOk: boolean;
  /** The scenario passed completely: department, all actions with parameters, nothing extra or forbidden. */
  passed: boolean;
}

export interface EvalSummary {
  scenarios: number;
  /** Total runs: scenarios × repeats. The rates below are per run. */
  runs: number;
  passed: number;
  /** Scenarios passed in every repeat, and those passed not always. */
  stable: number;
  flaky: number;
  department: { correct: number; total: number };
  actions: { expected: number; matched: number; paramsExact: number; proposed: number; extra: number };
  forbidden: number;
  failedRuns: number;
  skipped: number;
  tokens: { input: number; output: number };
  cost: { total: number; currency: string | null };
  durationMs: { total: number; average: number };
}

export interface EvalReport {
  startedAt: string;
  finishedAt: string;
  /** configHash — fingerprint of the agent configuration: the same for runs with the same instructions, model and settings. */
  /** locale — the language of the scenarios: runs in different languages are not comparable one to one. */
  config: { model: string | null; provider: string | null; configHash: string | null; corePromptVersion: number | null; source: string; locale?: string };
  summary: EvalSummary;
  scores: ScenarioScore[];
}

/** A parameter value matches: numbers by value ("19" and 19), the rest as JSON. */
export function paramValueEquals(expected: unknown, actual: unknown): boolean {
  if (typeof expected === 'number') return actual !== null && actual !== undefined && actual !== '' && Number(actual) === expected;
  return JSON.stringify(expected ?? null) === JSON.stringify(actual ?? null);
}

/** Whether the parameters match: only the keys given in the expectation are compared. */
export function paramsMatch(expected: Record<string, unknown>, actual: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => paramValueEquals(value, actual[key]));
}

export function scoreScenario(scenario: ScenarioExpectation, outcome: ScenarioOutcome, attempt = 1): ScenarioScore {
  const remaining = [...outcome.actions];
  const expected = scenario.actions.map((want) => {
    // First an action of the same type with matching parameters, then any of the same type.
    const exact = remaining.findIndex((a) => a.type === want.type && paramsMatch(want.params, a.params));
    const index = exact !== -1 ? exact : remaining.findIndex((a) => a.type === want.type);
    const actual = index === -1 ? null : remaining.splice(index, 1)[0]!;
    return { type: want.type, params: want.params, matched: actual !== null, paramsOk: actual !== null && paramsMatch(want.params, actual.params), actual: actual?.params ?? null };
  });
  const extra = remaining.map((a) => ({ type: a.type, params: a.params }));
  const forbidden = outcome.actions.filter((a) => scenario.forbidActions.includes(a.type)).map((a) => a.type);
  const departmentOk = outcome.department !== null && scenario.departments.includes(outcome.department);
  const needsHumanOk = scenario.needsHuman === undefined || outcome.needsHuman === scenario.needsHuman;
  const passed =
    outcome.status === 'applied' && departmentOk && needsHumanOk && expected.every((e) => e.matched && e.paramsOk) && extra.length === 0 && forbidden.length === 0;
  return { scenario, attempt, outcome, departmentOk, expected, extra, forbidden, needsHumanOk, passed };
}

export function summarize(scores: ScenarioScore[]): EvalSummary {
  const ran = scores.filter((s) => s.outcome.status !== 'skipped');
  const sum = (pick: (s: ScenarioScore) => number) => ran.reduce((total, s) => total + pick(s), 0);
  const durations = sum((s) => s.outcome.durationMs);
  const groups = [...groupByScenario(scores).values()].filter((g) => g.some((s) => s.outcome.status !== 'skipped'));
  return {
    scenarios: groupByScenario(scores).size,
    runs: scores.length,
    passed: scores.filter((s) => s.passed).length,
    stable: groups.filter((g) => g.every((s) => s.passed)).length,
    flaky: groups.filter((g) => g.some((s) => s.passed) && !g.every((s) => s.passed)).length,
    department: { correct: ran.filter((s) => s.departmentOk).length, total: ran.length },
    actions: {
      expected: sum((s) => s.expected.length),
      matched: sum((s) => s.expected.filter((e) => e.matched).length),
      paramsExact: sum((s) => s.expected.filter((e) => e.paramsOk).length),
      proposed: sum((s) => s.outcome.actions.length),
      extra: sum((s) => s.extra.length),
    },
    forbidden: sum((s) => s.forbidden.length),
    failedRuns: ran.filter((s) => s.outcome.status !== 'applied').length,
    skipped: scores.length - ran.length,
    tokens: { input: sum((s) => s.outcome.tokensIn), output: sum((s) => s.outcome.tokensOut) },
    cost: { total: Math.round(sum((s) => s.outcome.cost ?? 0) * 1000) / 1000, currency: ran.find((s) => s.outcome.currency)?.outcome.currency ?? null },
    durationMs: { total: durations, average: ran.length ? Math.round(durations / ran.length) : 0 },
  };
}

export function groupByScenario(scores: ScenarioScore[]): Map<string, ScenarioScore[]> {
  const groups = new Map<string, ScenarioScore[]>();
  for (const score of scores) groups.set(score.scenario.id, [...(groups.get(score.scenario.id) ?? []), score]);
  return groups;
}

const pct = (part: number, total: number) => (total === 0 ? '—' : `${part} / ${total} (${Math.round((part / total) * 100)}%)`);
const mark = (ok: boolean) => (ok ? '✓' : '✗');
const formatParams = (params: Record<string, unknown>) =>
  Object.entries(params)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ');

/** A report for humans: summary, scenario table, analysis of mismatches. */
export function renderMarkdown(report: EvalReport): string {
  const { summary: s, config } = report;
  const lines = [
    `# Agent evaluation — ${report.startedAt.slice(0, 16).replace('T', ' ')} UTC`,
    '',
    `Model: **${config.model ?? '—'}** (${config.provider ?? '—'}) · configuration \`${config.configHash?.slice(0, 8) ?? '—'}\` · core v${config.corePromptVersion ?? '—'} · settings from "${config.source}"${config.locale ? ` · scenarios: ${config.locale}` : ''}`,
    '',
    '| Metric | Value |',
    '|---|---|',
    `| Runs passed completely | ${pct(s.passed, s.runs)} |`,
    ...(s.runs > s.scenarios ? [`| Scenarios stable (in every repeat) | ${pct(s.stable, s.scenarios)}; flaky: ${s.flaky} |`] : []),
    `| Department | ${pct(s.department.correct, s.department.total)} |`,
    `| Actions: found by type (recall) | ${pct(s.actions.matched, s.actions.expected)} |`,
    `| Actions: exact parameters | ${pct(s.actions.paramsExact, s.actions.expected)} |`,
    `| Actions: extra among proposed | ${s.actions.extra} of ${s.actions.proposed} |`,
    `| Forbidden actions | ${s.forbidden} |`,
    `| Run errors | ${s.failedRuns}${s.skipped ? ` (skipped by budget: ${s.skipped})` : ''} |`,
    `| Tokens (input / output) | ${s.tokens.input.toLocaleString('en-US')} / ${s.tokens.output.toLocaleString('en-US')} |`,
    `| Cost | ${s.cost.total} ${s.cost.currency ?? ''} |`,
    `| Time per scenario | ${Math.round(s.durationMs.average / 100) / 10} s on average |`,
    '',
    '## Scenarios',
    '',
    '| Scenario | Department | Actions | Result |',
    '|---|---|---|---|',
  ];
  for (const [id, group] of groupByScenario(report.scores)) {
    // The row shows the first failed repeat (or the first one if all passed); the total is the share of repeats.
    const score = group.find((g) => !g.passed && g.outcome.status !== 'skipped') ?? group[0]!;
    const o = score.outcome;
    const ran = group.filter((g) => g.outcome.status !== 'skipped');
    const passed = group.filter((g) => g.passed).length;
    const department = o.status === 'skipped' ? '—' : `${mark(score.departmentOk)} ${score.departmentOk ? o.department : `${score.scenario.departments.join('|')} → ${o.department ?? 'none'}`}`;
    const actions = [
      ...score.expected.map((e) => `${mark(e.matched && e.paramsOk)} ${e.type}${e.matched && !e.paramsOk ? ' (parameters)' : e.matched ? '' : ' (missing)'}`),
      ...score.extra.map((e) => `✗ extra ${e.type}`),
    ];
    const verdict =
      ran.length === 0 ? 'skipped' : o.status !== 'applied' && o.status !== 'skipped' && group.length === 1 ? `error: ${o.status}` : group.length === 1 ? mark(score.passed) : `${passed === ran.length ? '✓' : passed === 0 ? '✗' : '≈'} ${passed}/${ran.length}`;
    lines.push(`| ${id} | ${department} | ${actions.join('; ') || '—'} | ${verdict} |`);
  }

  const misses = report.scores.filter((score) => !score.passed && score.outcome.status !== 'skipped');
  if (misses.length > 0) {
    lines.push('', '## Mismatches');
    for (const score of misses) {
      const o = score.outcome;
      lines.push('', `### ${score.scenario.id}${score.attempt > 1 || report.summary.runs > report.summary.scenarios ? ` (repeat ${score.attempt})` : ''} — ${score.scenario.title}`);
      if (score.scenario.note) lines.push(`Expectation: ${score.scenario.note}`);
      if (o.error) lines.push(`- Run error: ${o.error}`);
      if (!score.departmentOk) {
        lines.push(`- Department: expected \`${score.scenario.departments.join('|')}\`, got \`${o.department ?? 'none'}\` (the agent chose \`${o.agentDepartment ?? 'null'}\`, confidence ${o.confidence ?? '—'})`);
      }
      for (const e of score.expected.filter((x) => !x.matched || !x.paramsOk)) {
        lines.push(
          e.matched
            ? `- ${e.type}: expected ${formatParams(e.params)}, the agent proposed ${formatParams(e.actual ?? {})}`
            : `- ${e.type} not proposed (expected ${formatParams(e.params)})`,
        );
      }
      for (const e of score.extra) lines.push(`- Extra action ${e.type}: ${formatParams(e.params)}${score.forbidden.includes(e.type) ? ' — forbidden by the expectation' : ''}`);
      if (!score.needsHumanOk) lines.push(`- needs_human: expected ${score.scenario.needsHuman}, the agent — ${o.needsHuman}`);
      if (o.summary) lines.push(`- Agent summary: ${o.summary}`);
      if (o.tools.length) lines.push(`- Tools: ${o.tools.join(' → ')}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
