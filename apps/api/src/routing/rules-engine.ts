import type { RuleCondition, RuleEffect, RuleLeaf } from '@kvitok/shared';

/** Data the rule conditions are checked against. */
export interface RuleContextData {
  subject: string;
  body: string;
  channel: { id: string; type: string } | null;
  from: { email: string; domain: string } | null;
  metadata: Record<string, unknown>;
  fields: Record<string, unknown>;
  customer: { fields: Record<string, unknown>; identity: Record<string, string[]> } | null;
  ticket: { priority: string; department: string | null; tags: string[]; status: string };
  time: { hour: number; weekday: number };
  agent?: { department: string | null; confidence: number; needs_human: boolean };
}

export interface EvaluableRule {
  id: string;
  name: string;
  conditions: RuleCondition;
  effects: RuleEffect[];
  stop: boolean;
  enabled: boolean;
}

export function evaluateRules(rules: EvaluableRule[], ctx: RuleContextData): EvaluableRule[] {
  const matched: EvaluableRule[] = [];
  for (const rule of rules) {
    if (!rule.enabled || !evaluateCondition(rule.conditions, ctx)) {
      continue;
    }
    matched.push(rule);
    if (rule.stop) {
      break;
    }
  }
  return matched;
}

export function evaluateCondition(condition: RuleCondition, ctx: RuleContextData): boolean {
  if ('all' in condition) {
    return condition.all.every((c) => evaluateCondition(c, ctx));
  }
  if ('any' in condition) {
    return condition.any.some((c) => evaluateCondition(c, ctx));
  }
  if ('not' in condition) {
    return !evaluateCondition(condition.not, ctx);
  }
  return evaluateLeaf(condition, getPath(ctx, condition.field));
}

export function getPath(ctx: RuleContextData, path: string): unknown {
  let node: unknown = ctx;
  for (const part of path.split('.')) {
    if (node === null || node === undefined || typeof node !== 'object') {
      return undefined;
    }
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

function evaluateLeaf(leaf: RuleLeaf, actual: unknown): boolean {
  const values = Array.isArray(actual) ? actual : [actual];
  const expected = leaf.value;

  switch (leaf.op) {
    case 'is_empty':
      return isEmpty(actual);
    case 'is_not_empty':
      return !isEmpty(actual);
    case 'eq':
      return values.some((v) => looseEquals(v, expected));
    case 'neq':
      return !values.some((v) => looseEquals(v, expected));
    case 'in':
      return Array.isArray(expected) && values.some((v) => expected.some((e) => looseEquals(v, e)));
    case 'not_in':
      return !(Array.isArray(expected) && values.some((v) => expected.some((e) => looseEquals(v, e))));
    case 'contains':
      return values.some((v) => contains(v, expected));
    case 'not_contains':
      return !values.some((v) => contains(v, expected));
    case 'matches': {
      const re = new RegExp(String(expected ?? ''), 'i');
      return values.some((v) => v !== undefined && v !== null && re.test(String(v)));
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const limit = toNumber(expected);
      const op = leaf.op;
      return limit !== null && values.some((v) => compare(toNumber(v), limit, op));
    }
    case 'between': {
      if (!Array.isArray(expected) || expected.length !== 2) return false;
      const [from, to] = expected.map(toNumber);
      return from !== null && to !== null && values.some((v) => {
        const n = toNumber(v);
        return n !== null && n >= from! && n <= to!;
      });
    }
  }
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function looseEquals(actual: unknown, expected: unknown): boolean {
  const a = toNumber(actual);
  const b = toNumber(expected);
  if (a !== null && b !== null) return a === b;
  if (typeof actual === 'boolean' || typeof expected === 'boolean') return String(actual) === String(expected);
  if (actual === null || actual === undefined || expected === null || expected === undefined) return actual === expected;
  return String(actual).toLowerCase() === String(expected).toLowerCase();
}

function contains(actual: unknown, expected: unknown): boolean {
  if (actual === null || actual === undefined) return false;
  return String(actual).toLowerCase().includes(String(expected ?? '').toLowerCase());
}

function compare(value: number | null, limit: number, op: 'gt' | 'gte' | 'lt' | 'lte'): boolean {
  if (value === null) return false;
  return op === 'gt' ? value > limit : op === 'gte' ? value >= limit : op === 'lt' ? value < limit : value <= limit;
}

/** Value from a regular expression: the named group `value`, otherwise group 1, otherwise the whole match. */
export function extractByRegex(pattern: string, text: string): string | null {
  const match = new RegExp(pattern, 'i').exec(text);
  if (!match) return null;
  return (match.groups?.value ?? match[1] ?? match[0])?.trim() || null;
}
