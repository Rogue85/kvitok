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
} from '@kvitok/protocol';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { simActions } from './actions.js';
import { DEFAULT_SIM_LOCALE, localizer, type SimLocale } from './locale.js';
import { simTools } from './tools.js';

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
    identity_types: ['phone', 'email', 'card_number'],
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
      examples: a.examples,
    })),
    playbooks,
    suggested_departments: departments,
  });
}

export function manifestEtag(manifest: Manifest): string {
  return `"${createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 16)}"`;
}
