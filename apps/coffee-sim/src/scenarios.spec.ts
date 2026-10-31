import { describe, expect, it } from 'vitest';
import { simActions } from './actions.js';
import { SIM_LOCALES } from './locale.js';
import { buildManifest } from './manifest.js';
import { ingestPayload, loadWorld } from './scenarios.js';
import { SimStore } from './store.js';

describe.each(SIM_LOCALES)('scenarios (%s)', (locale) => {
  const world = loadWorld({ locale });
  const store = new SimStore(world.base, world.scenarios);
  const actions = simActions(locale);

  it('all scenarios are valid and build one world', () => {
    expect(world.scenarios.length).toBeGreaterThanOrEqual(12);
    expect(store.guests.size).toBeGreaterThan(10);
  });

  it('cover departments, actions and "no action" cases', () => {
    const departments = new Set(world.scenarios.flatMap((s) => [s.expect.department].flat()));
    const expected = new Set(world.scenarios.flatMap((s) => s.expect.actions.map((a) => a.type)));
    expect([...departments].sort()).toEqual(['app', 'loyalty', 'stores', 'triage']);
    expect([...expected].sort()).toEqual(actions.map((a) => a.name).sort());
    expect(world.scenarios.filter((s) => s.expect.actions.length === 0).length).toBeGreaterThanOrEqual(4);
  });

  describe.each(world.scenarios.filter((s) => s.expect.actions.length > 0).map((s) => [s.id, s] as const))('%s', (_id, scenario) => {
    it('expected actions pass validate without changing parameters', () => {
      const guest = store.guests.get(scenario.ticket.customer!)!;
      for (const expected of scenario.expect.actions) {
        const action = actions.find((a) => a.name === expected.type)!;
        const params = action.input.parse({ reason: 'scenario reference', ...expected.params });
        const outcome = action.validate({ store, guest }, params);
        expect(outcome.errors).toEqual([]);
        expect(outcome.ok).toBe(true);
        expect(outcome.normalized).toMatchObject(expected.params);
      }
    });
  });

  it('a single scenario loads on its own', () => {
    const single = loadWorld({ ids: ['cups-not-counted'], locale });
    expect(single.scenarios.map((s) => s.id)).toEqual(['cups-not-counted']);
    expect(() => loadWorld({ ids: ['nope'], locale })).toThrow(/No such scenarios: nope/);
  });

  it('a scenario ticket for ingest: guest identities and the original time with an offset', () => {
    const scenario = world.scenarios.find((s) => s.id === 'receipt-not-on-card')!;
    expect(ingestPayload(scenario, store)).toMatchObject({
      external_id: 'sim-receipt-not-on-card',
      customer: { name: locale === 'ru' ? 'Анна' : 'Anna', identities: { phone: '79000000001', email: 'anna@example.test' } },
      sent_at: '2026-10-15T09:10:00+03:00',
      metadata: { scenario: 'receipt-not-on-card' },
    });
    const unknown = world.scenarios.find((s) => s.id === 'unknown-guest')!;
    expect(ingestPayload(unknown, store).customer.identities).toEqual({ phone: '79000000015', email: 'petr@example.test' });
  });
});

/** Keys whose string values are human text and differ between languages. */
const TEXT_KEYS = new Set(['title', 'name', 'city', 'guest_city', 'description', 'group', 'drink_groups', 'subject', 'body', 'note', 'lines', 'when', 'examples', 'instructions']);

/** Human text → the numbers in it: a translation may reword, but not change amounts, dates or counts. */
const numbers = (text: string) => (text.match(/\d+/g) ?? []).sort();

/** Everything but the text stays as is; the text is reduced to its numbers. */
function skeleton(value: unknown, text = false): unknown {
  if (typeof value === 'string') return text ? numbers(value) : value;
  if (Array.isArray(value)) return value.map((v) => skeleton(v, text));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, skeleton(v, text || TEXT_KEYS.has(k))]));
  return value;
}

const CYRILLIC = /[а-яё]/i;

describe('languages describe the same world', () => {
  const worlds = Object.fromEntries(SIM_LOCALES.map((locale) => [locale, loadWorld({ locale })]));

  it('the same scenarios, reference data and expectations; texts carry the same numbers', () => {
    const [first, ...rest] = SIM_LOCALES.map((locale) => skeleton(worlds[locale]));
    for (const other of rest) expect(other).toEqual(first);
  });

  it('the same manifest apart from the texts', () => {
    // Descriptions of tool and action arguments are text too.
    const shape = (locale: (typeof SIM_LOCALES)[number]) => JSON.parse(JSON.stringify(skeleton(buildManifest(locale))), (key, value) => (key === 'description' ? undefined : value));
    const [first, ...rest] = SIM_LOCALES.map(shape);
    for (const other of rest) expect(other).toEqual(first);
  });

  it('the English dataset and manifest have no Russian left', () => {
    expect(JSON.stringify(worlds.en)).not.toMatch(CYRILLIC);
    expect(JSON.stringify(buildManifest('en'))).not.toMatch(CYRILLIC);
  });
});
