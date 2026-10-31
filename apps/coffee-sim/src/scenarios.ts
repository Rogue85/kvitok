import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_SIM_LOCALE, type SimLocale } from './locale.js';
import { PACKAGE_ROOT } from './manifest.js';
import type { Guest, SimStore } from './store.js';
import { BaseWorldSchema, formatIsoLocal, ScenarioSchema, type BaseWorld, type Scenario } from './world.js';

/** One dataset per language: `scenarios/en`, `scenarios/ru`. */
export const SCENARIOS_DIR = join(PACKAGE_ROOT, 'scenarios');
const BASE_FILE = '_base.yaml';

export class ScenarioFileError extends Error {}

function readYaml(file: string): unknown {
  try {
    return parseYaml(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ScenarioFileError(`${file}: ${(error as Error).message}`);
  }
}

function issues(file: string, error: { issues: Array<{ path: PropertyKey[]; message: string }> }): ScenarioFileError {
  return new ScenarioFileError(`${file}:\n${error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')}`);
}

/** Reference data and all scenarios of one language; `ids` — load only these scenarios; `dir` — a catalog instead of `scenarios/<locale>`. */
export function loadWorld(options: { dir?: string; ids?: string[]; locale?: SimLocale } = {}): { base: BaseWorld; scenarios: Scenario[] } {
  const dir = options.dir ?? join(SCENARIOS_DIR, options.locale ?? DEFAULT_SIM_LOCALE);
  const baseParsed = BaseWorldSchema.safeParse(readYaml(join(dir, BASE_FILE)));
  if (!baseParsed.success) throw issues(BASE_FILE, baseParsed.error);

  const scenarios = readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') && f !== BASE_FILE)
    .sort()
    .map((file) => {
      const parsed = ScenarioSchema.safeParse(readYaml(join(dir, file)));
      if (!parsed.success) throw issues(file, parsed.error);
      if (`${parsed.data.id}.yaml` !== file) throw new ScenarioFileError(`${file}: the scenario id must match the file name`);
      return parsed.data;
    });

  if (options.ids) {
    const known = new Set(scenarios.map((s) => s.id));
    const unknown = options.ids.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new ScenarioFileError(`No such scenarios: ${unknown.join(', ')}`);
    return { base: baseParsed.data, scenarios: scenarios.filter((s) => options.ids!.includes(s.id)) };
  }
  return { base: baseParsed.data, scenarios };
}

/** Identities of the ticket customer: explicit from the scenario or from the guest profile. */
export function ticketIdentities(scenario: Scenario, store: SimStore): Record<string, string> {
  if (scenario.ticket.identities) return scenario.ticket.identities;
  const guest = scenario.ticket.customer ? store.guests.get(scenario.ticket.customer) : undefined;
  if (!guest) return {};
  return { phone: guest.phone, ...(guest.email ? { email: guest.email } : {}) };
}

/** Body of `POST /api/v1/ingest/:channelId` for a scenario ticket. */
export function ingestPayload(scenario: Scenario, store: SimStore) {
  const guest: Guest | undefined = scenario.ticket.customer ? store.guests.get(scenario.ticket.customer) : undefined;
  return {
    external_id: `sim-${scenario.id}`,
    customer: { name: scenario.ticket.name ?? guest?.name, identities: ticketIdentities(scenario, store) },
    subject: scenario.ticket.subject,
    body: scenario.ticket.body,
    sent_at: formatIsoLocal(store.time(scenario.ticket.sent_at), store.base.timezone),
    metadata: { scenario: scenario.id, tags: scenario.tags },
  };
}
