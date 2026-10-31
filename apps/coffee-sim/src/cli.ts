#!/usr/bin/env node
/**
 *   coffee-sim serve [--port 3100] [--host 127.0.0.1] [--scenarios a,b] [--locale en|ru]
 *   coffee-sim conformance [--url http://…] [--secret …]   without --url — starts the simulator in-process
 *   coffee-sim scenarios                                     list scenarios and expectations
 *   coffee-sim seed --api http://localhost:3001/api --channel <id> --key <api key> [--scenarios a,b]
 *
 * Signing secret — SIM_SECRET (a dev value by default, for local work only).
 * Language of the dataset and of the texts the agent sees — --locale or SIM_LOCALE, `en` by default.
 */
import { formatConformanceReport, runConformance } from '@kvitok/protocol';
import { parseArgs } from 'node:util';
import { DEFAULT_SIM_LOCALE, parseSimLocale } from './locale.js';
import { simConformanceProfile } from './profile.js';
import { ingestPayload, loadWorld } from './scenarios.js';
import { createSimServer } from './server.js';
import { SimStore } from './store.js';

const DEV_SECRET = 'coffee-sim-dev-secret';
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string', default: process.env.PORT ?? '3100' },
    host: { type: 'string', default: '127.0.0.1' },
    scenarios: { type: 'string' },
    locale: { type: 'string', default: process.env.SIM_LOCALE },
    secret: { type: 'string', default: process.env.SIM_SECRET ?? DEV_SECRET },
    url: { type: 'string' },
    api: { type: 'string', default: 'http://localhost:3001/api' },
    channel: { type: 'string' },
    key: { type: 'string', default: process.env.INGEST_API_KEY },
  },
});
const scenarioIds = values.scenarios?.split(',').map((s) => s.trim()).filter(Boolean);
const locale = (() => {
  try {
    return parseSimLocale(values.locale) ?? DEFAULT_SIM_LOCALE;
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
})();

async function serve(): Promise<void> {
  const sim = createSimServer({ secret: values.secret!, scenarios: scenarioIds, locale, logger: false });
  const url = await sim.listen(Number(values.port), values.host);
  console.log(`coffee-sim: ${url} — locale: ${locale}, scenarios: ${sim.store.scenarios.length}, guests: ${sim.store.guests.size}, "now": ${sim.store.base.now}`);
  if (values.secret === DEV_SECRET) console.log('The signing secret is the default dev value; set SIM_SECRET if the simulator is reachable by anyone but you.');
}

async function conformance(): Promise<void> {
  let url = values.url;
  let close: (() => Promise<void>) | null = null;
  const world = loadWorld({ ids: scenarioIds, locale });
  const store = new SimStore(world.base, world.scenarios);
  if (!url) {
    const sim = createSimServer({ secret: values.secret!, scenarios: scenarioIds, locale });
    url = await sim.listen();
    close = () => sim.close();
  }
  const report = await runConformance(simConformanceProfile(store, url, values.secret!));
  console.log(formatConformanceReport(report));
  await close?.();
  process.exitCode = report.ok ? 0 : 1;
}

function scenarios(): void {
  const world = loadWorld({ ids: scenarioIds, locale });
  for (const s of world.scenarios) {
    const actions = s.expect.actions.map((a) => a.type).join(', ') || 'no actions';
    console.log(`${s.id.padEnd(34)} ${[s.expect.department].flat().join('|').padEnd(8)} ${actions.padEnd(28)} ${s.title}`);
  }
}

async function seed(): Promise<void> {
  if (!values.channel || !values.key) throw new Error('--channel and --key (or INGEST_API_KEY) of a Kvitok API channel are required');
  const world = loadWorld({ ids: scenarioIds, locale });
  const store = new SimStore(world.base, world.scenarios);
  for (const scenario of world.scenarios) {
    const response = await fetch(`${values.api}/v1/ingest/${values.channel}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${values.key}` },
      body: JSON.stringify(ingestPayload(scenario, store)),
    });
    const body = (await response.json()) as { ticket_number?: number; duplicate?: boolean };
    console.log(`${scenario.id.padEnd(34)} ${response.ok ? `#${body.ticket_number}${body.duplicate ? ' (already there)' : ''}` : `${response.status} ${JSON.stringify(body)}`}`);
  }
}

const commands: Record<string, () => void | Promise<void>> = { serve, conformance, scenarios, seed };
const command = commands[positionals[0] ?? 'serve'];
if (!command) {
  console.error('Commands: serve | conformance | scenarios | seed');
  process.exit(2);
}
try {
  await command();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
