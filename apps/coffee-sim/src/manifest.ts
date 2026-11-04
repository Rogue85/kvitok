import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DepartmentSuggestionSchema,
  ManifestSchema,
  PlaybookDefinitionSchema,
  PROTOCOL_VERSION,
  type InputSchema,
  type Manifest,
  type Option,
} from '@kvitok/protocol';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { simActions } from './actions.js';
import { DEFAULT_SIM_LOCALE, localizer, type SimLocale } from './locale.js';
import { simTools } from './tools.js';
import type { BaseWorld } from './world.js';

/** Package root: one level up from both src/ and dist/. */
export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
/** Knowledge for the agent, one folder per language: `content/en`, `content/ru`. */
const CONTENT_DIR = join(PACKAGE_ROOT, 'content');

/** JSON Schema of the arguments from zod — what the model sees in the tool description. */
export function toInputSchema(schema: z.ZodType): InputSchema {
  const { $schema: _, ...json } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  return json as InputSchema;
}

/** Markdown with a YAML header: `---\nkey: …\n---\ntext`. */
function readFrontMatter(file: string): { meta: Record<string, unknown>; body: string } {
  const text = readFileSync(file, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${file}: no YAML front matter`);
  return { meta: parseYaml(match[1]!) as Record<string, unknown>, body: match[2]!.trim() };
}

export function buildManifest(locale: SimLocale = DEFAULT_SIM_LOCALE): Manifest {
  const l = localizer(locale);
  const contentDir = join(CONTENT_DIR, locale);
  const playbooksDir = join(contentDir, 'playbooks');
  const playbooks = readdirSync(playbooksDir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((file) => {
      const { meta, body } = readFrontMatter(join(playbooksDir, file));
      return PlaybookDefinitionSchema.parse({ ...meta, body });
    });
  const departments = z.array(DepartmentSuggestionSchema).parse(parseYaml(readFileSync(join(contentDir, 'departments.yaml'), 'utf8')));

  return ManifestSchema.parse({
    protocol_version: PROTOCOL_VERSION,
    name: 'coffee_sim',
    title: l({ en: 'Coffee shop chain (simulator)', ru: 'Сеть кофеен (симулятор)' }),
    identity_types: [
      {
        type: 'phone',
        label: l({ en: 'Phone', ru: 'Телефон' }),
        // A Russian mobile number in any common spelling: +7 (912) 345-67-89, 89123456789.
        pattern: String.raw`(?<![\d+])(?<value>(?:\+7|8|7)[\s\-(]*9\d{2}[\s\-)]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2})(?!\d)`,
        normalize: 'digits',
        description: l({ en: 'Russian mobile number, 11 digits starting with 7', ru: 'Российский мобильный номер, 11 цифр, начинается с 7' }),
      },
      { type: 'email', label: 'Email', normalize: 'lowercase' },
      {
        type: 'card_number',
        label: l({ en: 'Loyalty card', ru: 'Карта лояльности' }),
        pattern: String.raw`(?<!\d)(?<value>70\d{7})(?!\d)`,
        normalize: 'digits',
        description: l({ en: '9 digits starting with 70, printed on the card and shown in the app', ru: '9 цифр, начинается с 70, напечатан на карте и виден в приложении' }),
      },
    ],
    instructions: readFileSync(join(contentDir, 'instructions.md'), 'utf8').trim(),
    tools: simTools(locale).map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      input_schema: toInputSchema(t.input),
      display: t.display,
      requires_customer: t.requiresCustomer,
      cache_ttl_seconds: t.cacheTtlSeconds,
      examples: t.examples,
    })),
    actions: simActions(locale).map((a) => ({
      name: a.name,
      title: a.title,
      description: a.description,
      input_schema: toInputSchema(a.input),
      requires_approval: true,
      audience: a.audience ?? ['agent', 'operator'],
      examples: a.examples,
    })),
    playbooks,
    suggested_departments: departments,
    option_sets: [
      {
        name: PLACES_OPTION_SET,
        title: l({ en: 'Coffee shops', ru: 'Кофейни' }),
        description: l({
          en: 'Coffee shops of the chain. value is the coffee shop id: the same as place_id in get_transactions and get_orders. group is the city.',
          ru: 'Кофейни сети. value — id кофейни: то же, что place_id в get_transactions и get_orders. group — город.',
        }),
      },
    ],
  });
}

/** The directory of coffee shops: the options come from the world's places. */
export const PLACES_OPTION_SET = 'places';

export function placeOptions(places: BaseWorld['places']): Option[] {
  return places.map((p) => ({ value: p.id, label: p.name, group: p.city, ...(p.description ? { description: p.description } : {}), active: p.active }));
}

export function manifestEtag(manifest: Manifest): string {
  return `"${createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 16)}"`;
}
