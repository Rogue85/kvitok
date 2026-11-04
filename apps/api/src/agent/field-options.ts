import { activeOptions, AGENT_OPTIONS_LIST_LIMIT, type FieldDefinitionDto, type FieldOption } from '@kvitok/shared';
import type { LlmTool } from '../llm/llm.types';
import type { AgentFieldValue } from './submit-schema';

/** A built-in tool: search the options of a select field that are too many to list in the prompt. */
export const FIND_FIELD_OPTIONS = 'find_field_options';
/** Candidates the agent may offer for one field. */
export const MAX_CANDIDATES = 5;
const SEARCH_LIMIT = 10;
/** Trigram similarity of a word to count as a typo of another one. */
const FUZZY_THRESHOLD = 0.35;

export type OptionsPresentation = 'list' | 'search';

/** How the agent sees a field's options; null — the field has none (not a select). */
export function optionsPresentation(field: Pick<FieldDefinitionDto, 'type' | 'options' | 'agentOptionsMode'>): OptionsPresentation | null {
  if (field.type !== 'select' && field.type !== 'multiselect') return null;
  if (field.agentOptionsMode === 'list' || field.agentOptionsMode === 'search') return field.agentOptionsMode;
  return activeOptions(field.options).length > AGENT_OPTIONS_LIST_LIMIT ? 'search' : 'list';
}

/** One option for the model: `512 — Tverskaya St, 12 · Moscow · Pushkinskaya metro`. */
export function optionLine(option: FieldOption): string {
  return [`${option.value} — ${option.label}`, option.group, option.agentHint].filter(Boolean).join(' · ');
}

/** Lowercase, ё → е, letters and digits only: "ТЦ «Кристалл»" and "тц кристалл" compare equal. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function trigrams(text: string): Set<string> {
  const padded = `  ${text} `;
  const result = new Set<string>();
  for (let i = 0; i < padded.length - 2; i += 1) result.add(padded.slice(i, i + 3));
  return result;
}

function similarity(a: Set<string>, b: Set<string>): number {
  let common = 0;
  for (const gram of a) if (b.has(gram)) common += 1;
  return common / (a.size + b.size - common || 1);
}

/**
 * Searches active options by value, label, group and hint. A query word counts when an option word starts with it,
 * a label match weighs more, an exact value comes first. Without word matches, trigram similarity catches typos.
 */
export function searchOptions(options: FieldOption[], query: string, limit = SEARCH_LIMIT): { options: FieldOption[]; total: number } {
  const active = activeOptions(options);
  const normalized = normalizeText(query);
  const words = normalized.split(' ').filter(Boolean);
  if (words.length === 0) return { options: active.slice(0, limit), total: active.length };
  const queryGrams = words.map(trigrams);

  const scored = active.map((option) => {
    if (option.value.toLowerCase() === query.trim().toLowerCase()) return { option, score: 100 };
    const label = normalizeText(option.label).split(' ');
    const other = normalizeText([option.group, option.agentHint, option.value].filter(Boolean).join(' ')).split(' ');
    let score = 0;
    for (const word of words) {
      if (label.some((w) => w.startsWith(word))) score += 2;
      else if (other.some((w) => w.startsWith(word))) score += 1;
    }
    if (score === 0) {
      // Every query word against its closest option word: "Тверcкая" with a Latin c still finds "Тверская".
      const optionGrams = [...label, ...other].filter(Boolean).map(trigrams);
      const fuzzy = queryGrams.reduce((sum, grams) => sum + Math.max(0, ...optionGrams.map((g) => similarity(grams, g))), 0) / queryGrams.length;
      score = fuzzy >= FUZZY_THRESHOLD ? fuzzy : 0;
    }
    return { option, score };
  });
  const matched = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  return { options: matched.slice(0, limit).map((s) => s.option), total: matched.length };
}

export function buildFindFieldOptionsTool(fields: FieldDefinitionDto[]): LlmTool {
  return {
    name: FIND_FIELD_OPTIONS,
    description:
      'Find options of a field whose options are not listed in the prompt. Search by words the customer or the data uses: a name, an address, a landmark, a city; or pass an id from tool data to check it. Returns up to 10 best matches.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['field', 'query'],
      properties: {
        field: { type: 'string', enum: fields.map((f) => f.key) },
        query: { type: 'string', description: 'Words to search for, or an option value' },
      },
    },
  };
}

/** The answer of find_field_options for the model. */
export function runFindFieldOptions(args: unknown, fields: FieldDefinitionDto[]): { content: string; error: string | null } {
  const { field: key, query } = (args ?? {}) as { field?: unknown; query?: unknown };
  const field = fields.find((f) => f.key === key);
  if (!field) {
    return { content: `Unknown field "${String(key)}". Fields with searchable options: ${fields.map((f) => f.key).join(', ')}`, error: 'unknown field' };
  }
  const found = searchOptions(field.options, typeof query === 'string' ? query : '');
  return {
    content: JSON.stringify({
      field: field.key,
      total_matches: found.total,
      options: found.options.map((o) => ({ value: o.value, label: o.label, ...(o.group ? { group: o.group } : {}), ...(o.agentHint ? { description: o.agentHint } : {}) })),
    }),
    error: null,
  };
}

/**
 * Checks the agent's values of select fields against the active options. Invalid values are problems (the runner asks
 * the model to fix them once) and are dropped when the result is accepted anyway; invalid candidates are dropped quietly.
 * A field with neither a value nor candidates is left out.
 */
export function checkFieldOptions(
  values: Record<string, AgentFieldValue>,
  fields: FieldDefinitionDto[],
): { fields: Record<string, AgentFieldValue>; problems: string[] } {
  const result: Record<string, AgentFieldValue> = {};
  const problems: string[] = [];
  for (const [key, entry] of Object.entries(values)) {
    const field = fields.find((f) => f.key === key);
    const presentation = field ? optionsPresentation(field) : null;
    if (!field || presentation === null) {
      // Candidates are an answer to "which of the options": a text field or a field the agent was not offered has none.
      const { candidates: _ignored, ...rest } = entry;
      result[key] = rest;
      continue;
    }
    const allowed = new Set(activeOptions(field.options).map((o) => o.value));
    const hint = presentation === 'search' ? `find it with ${FIND_FIELD_OPTIONS}` : 'use a value from the list';
    const asText = (v: unknown) => (typeof v === 'number' ? String(v) : v);

    if (field.type === 'multiselect') {
      const list = (Array.isArray(entry.value) ? entry.value : entry.value === null || entry.value === undefined ? [] : [entry.value]).map(asText);
      const valid = [...new Set(list.filter((v): v is string => typeof v === 'string' && allowed.has(v)))];
      const invalid = list.filter((v) => !(typeof v === 'string' && allowed.has(v)));
      if (invalid.length > 0) problems.push(`fields.${key}.value: ${invalid.map((v) => JSON.stringify(v)).join(', ')} are not options of ${key}; ${hint}, or leave them out`);
      if (valid.length > 0) result[key] = { ...entry, value: valid, candidates: [] };
      continue;
    }

    const raw = asText(entry.value);
    let value: string | null = null;
    if (raw !== null && raw !== undefined && raw !== '') {
      if (typeof raw === 'string' && allowed.has(raw)) {
        value = raw;
      } else {
        problems.push(
          `fields.${key}.value: ${JSON.stringify(raw)} is not an option of ${key}; ${hint}, put the plausible options in candidates with value null, or leave the field out`,
        );
      }
    }
    const candidates = [...new Set((entry.candidates ?? []).map(asText).filter((v): v is string => typeof v === 'string' && allowed.has(v) && v !== value))].slice(
      0,
      MAX_CANDIDATES,
    );
    if (value === null && candidates.length === 0) continue;
    result[key] = { ...entry, value, candidates };
  }
  return { fields: result, problems };
}
