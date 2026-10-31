import { describe, expect, it } from 'vitest';
import { evaluateCondition, evaluateRules, extractByRegex, type RuleContextData } from './rules-engine';

const ctx: RuleContextData = {
  subject: 'Re: [DEP-214] Не печатает принтер',
  body: 'Привет! Отдел 214, третий этаж',
  channel: { id: 'ch1', type: 'email' },
  from: { email: 'petr@corp.example', domain: 'corp.example' },
  metadata: { form: { category: 'bonus' } },
  fields: { dept_number: 214, equipment: ['printer'] },
  customer: { fields: { vip: true }, identity: { email: ['petr@corp.example'] } },
  ticket: { priority: 'normal', department: null, tags: ['b2b'], status: 'new' },
  time: { hour: 10, weekday: 6 },
  agent: { department: 'it', confidence: 0.4, needs_human: false },
};

describe('evaluateCondition', () => {
  it.each([
    [{ field: 'channel.type', op: 'eq', value: 'EMAIL' }, true],
    [{ field: 'from.domain', op: 'in', value: ['corp.example', 'x.ru'] }, true],
    [{ field: 'subject', op: 'contains', value: 'принтер' }, true],
    [{ field: 'subject', op: 'matches', value: '\\[DEP-\\d{3}\\]' }, true],
    [{ field: 'fields.dept_number', op: 'between', value: [200, 299] }, true],
    [{ field: 'fields.dept_number', op: 'eq', value: '214' }, true],
    [{ field: 'fields.dept_number', op: 'gt', value: 300 }, false],
    [{ field: 'fields.equipment', op: 'contains', value: 'print' }, true],
    [{ field: 'fields.missing', op: 'is_empty' }, true],
    [{ field: 'metadata.form.category', op: 'eq', value: 'bonus' }, true],
    [{ field: 'customer.identity.email', op: 'eq', value: 'petr@corp.example' }, true],
    [{ field: 'customer.fields.vip', op: 'eq', value: true }, true],
    [{ field: 'ticket.tags', op: 'not_contains', value: 'vip' }, true],
    [{ field: 'time.weekday', op: 'in', value: [6, 7] }, true],
    [{ field: 'agent.confidence', op: 'lt', value: 0.6 }, true],
    [{ field: 'agent.needs_human', op: 'eq', value: false }, true],
  ] as const)('%j → %s', (condition, expected) => {
    expect(evaluateCondition(condition as never, ctx)).toBe(expected);
  });

  it('all / any / not', () => {
    expect(
      evaluateCondition(
        {
          all: [
            { field: 'channel.type', op: 'eq', value: 'email' },
            { any: [{ field: 'from.domain', op: 'eq', value: 'nope' }, { not: { field: 'ticket.priority', op: 'eq', value: 'urgent' } }] },
          ],
        },
        ctx,
      ),
    ).toBe(true);
  });
});

describe('evaluateRules', () => {
  const rule = (id: string, stop = false, enabled = true) => ({
    id,
    name: id,
    conditions: { field: 'channel.type', op: 'eq' as const, value: 'email' },
    effects: [{ type: 'add_tags' as const, tags: [id] }],
    stop,
    enabled,
  });

  it('goes in order, skips disabled ones and stops at stop', () => {
    expect(evaluateRules([rule('a'), rule('b', false, false), rule('c', true), rule('d')], ctx).map((r) => r.id)).toEqual(['a', 'c']);
  });
});

describe('extractByRegex', () => {
  it('takes the named group value, then group 1, then the whole match', () => {
    expect(extractByRegex('\\[DEP-(?<value>\\d+)\\]', ctx.subject)).toBe('214');
    expect(extractByRegex('отдел (\\d{3})', ctx.body)).toBe('214');
    expect(extractByRegex('\\d{3}', ctx.body)).toBe('214');
    expect(extractByRegex('нет такого', ctx.body)).toBeNull();
  });
});
