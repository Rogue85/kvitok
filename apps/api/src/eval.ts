import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { getLocale } from '@kvitok/i18n';
import { createApp } from './app.factory';
import { renderMarkdown } from './eval/compare';
import { EvalRunner, type EnvProvider } from './eval/eval-runner';

const USAGE = `Agent evaluation on the coffee-sim simulator scenarios.

  pnpm eval --from <workspace> [--scenarios a,b] [--tag hard] [--locale ru] [--repeat 2] [--model m] [--concurrency 2] [--budget 20] [--min-pass 0.8] [--out dir]

  --from        workspace providing the policy, settings, departments, playbooks, provider and model of the agent
  without --from  provider from EVAL_LLM_BASE_URL, EVAL_LLM_API_KEY, EVAL_LLM_MODEL
                (prices — EVAL_LLM_PRICE_IN / EVAL_LLM_PRICE_OUT per million tokens, currency — EVAL_LLM_CURRENCY)
  --tag         only scenarios with the tag (hard, loyalty, …)
  --locale      language of the scenarios (en, ru); the installation language (APP_LOCALE) by default
  --repeat      run every scenario N times — shows flaky ones
  --budget      do not start new scenarios once more than this was spent (in the workspace currency)
  --min-pass    exit code 1 if the share of passed scenarios is lower

Every run recreates the "eval" workspace — its tickets can be opened in the interface.`;

// Separate queues: the dev worker must not pick up evaluation tickets.
process.env.QUEUE_PREFIX ??= 'eval-bull';

function envProvider(): EnvProvider | undefined {
  const { EVAL_LLM_BASE_URL: baseUrl, EVAL_LLM_API_KEY: apiKey, EVAL_LLM_MODEL: model } = process.env;
  if (!baseUrl || !apiKey || !model) return undefined;
  const price = (value: string | undefined) => (value ? Number(value) : undefined);
  return {
    name: process.env.EVAL_LLM_NAME ?? 'Evaluation',
    baseUrl,
    apiKey,
    model,
    inputPerMillion: price(process.env.EVAL_LLM_PRICE_IN),
    outputPerMillion: price(process.env.EVAL_LLM_PRICE_OUT),
    currency: process.env.EVAL_LLM_CURRENCY,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      scenarios: { type: 'string' },
      tag: { type: 'string' },
      locale: { type: 'string' },
      model: { type: 'string' },
      concurrency: { type: 'string', default: '2' },
      repeat: { type: 'string', default: '1' },
      budget: { type: 'string' },
      'min-pass': { type: 'string' },
      out: { type: 'string', default: resolve(__dirname, '..', '..', '..', 'eval-reports') },
      help: { type: 'boolean', default: false },
    },
  });
  const provider = envProvider();
  if (values.help || (!values.from && !provider)) {
    console.log(USAGE);
    process.exitCode = values.help ? 0 : 2;
    return;
  }

  const sim = await import('@kvitok/coffee-sim');
  const ids = values.scenarios?.split(',').map((s) => s.trim()).filter(Boolean);
  const secret = randomBytes(16).toString('hex');
  // The app sets the installation language while starting, so it starts first.
  const app = await createApp({ logger: ['error'] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const locale = sim.parseSimLocale(values.locale ?? getLocale());
  const server = sim.createSimServer({ secret, scenarios: ids, locale, admin: false });
  const url = await server.listen();

  try {
    const scenarios = server.store.scenarios.filter((s) => !values.tag || s.tags.includes(values.tag));
    console.log(`Scenarios: ${scenarios.length} (${server.locale}), settings: ${values.from ?? 'EVAL_LLM_*'}${values.model ? `, model ${values.model}` : ''}`);
    const report = await new EvalRunner(app).run({
      scenarios,
      sim: { url, secret, ingestPayload: (scenario) => sim.ingestPayload(scenario, server.store) },
      locale: server.locale,
      settingsFrom: values.from,
      provider,
      model: values.model,
      concurrency: Number(values.concurrency),
      repeat: Number(values.repeat),
      budget: values.budget === undefined ? undefined : Number(values.budget),
      onProgress: (score, done, total) => {
        const o = score.outcome;
        const actions = o.actions.map((a) => a.type).join(', ') || 'no actions';
        console.log(
          `${String(done).padStart(2)}/${total} ${score.passed ? '✓' : o.status === 'skipped' ? '–' : '✗'} ${`${score.scenario.id}${score.attempt > 1 ? ` #${score.attempt}` : ''}`.padEnd(32)} ${(o.department ?? '—').padEnd(8)} ${actions.padEnd(28)} ${(o.durationMs / 1000).toFixed(1)} s${o.cost !== null ? `, ${o.cost.toFixed(3)} ${o.currency ?? ''}` : ''}`,
        );
      },
    });

    const markdown = renderMarkdown(report);
    await mkdir(values.out!, { recursive: true });
    const name = `eval-${report.startedAt.slice(0, 19).replace(/[:T]/g, '-')}`;
    await writeFile(join(values.out!, `${name}.md`), markdown);
    await writeFile(join(values.out!, `${name}.json`), JSON.stringify(report, null, 2));
    console.log(`\n${markdown}\nReport: ${join(values.out!, `${name}.md`)} (+ .json)`);

    const minPass = values['min-pass'] === undefined ? undefined : Number(values['min-pass']);
    if (minPass !== undefined && report.summary.passed / Math.max(1, report.summary.scenarios) < minPass) {
      console.error(`Less than ${Math.round(minPass * 100)}% of scenarios passed`);
      process.exitCode = 1;
    }
  } finally {
    await app.close();
    await server.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
