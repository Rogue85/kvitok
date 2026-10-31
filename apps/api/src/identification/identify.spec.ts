import { describe, expect, it } from 'vitest';
import { findAll, identify, occursIn, type IdentificationContext, type IdentificationRuleLike, type ManifestIdentityPattern } from './identify';

const ctx = (overrides: Partial<IdentificationContext> = {}): IdentificationContext => ({
  subject: 'Новое обращение в поддержку: Баллы',
  body: 'Имя: Анна\nТелефон: +7 (900) 000-00-01\nEmail: anna@example.test\nБаллы не пришли за вчерашний чек.',
  channel: { id: 'ch1', type: 'email' },
  from: { email: 'noreply@app.example', domain: 'app.example' },
  reply_to: { email: 'anna@example.test', domain: 'example.test' },
  sender: { authenticated: true },
  metadata: {},
  header: { 'x-form': 'support' },
  ...overrides,
});

const formRule: IdentificationRuleLike = {
  id: 'r1',
  name: 'App form',
  conditions: { field: 'from.email', op: 'eq', value: 'noreply@app.example' },
  customerFrom: 'reply_to',
  extract: [
    { identityType: 'phone', source: 'body', pattern: 'Телефон:\\s*(?<value>.+)', trust: 'claimed' },
    { identityType: 'name', source: 'body', pattern: 'Имя:\\s*(.+)', trust: 'claimed' },
  ],
  stop: false,
  enabled: true,
};

const cardPattern: ManifestIdentityPattern = {
  integrationId: 'i1',
  integrationName: 'Coffee',
  type: 'card_number',
  pattern: '(?<!\\d)(?<value>70\\d{7})(?!\\d)',
  normalize: 'digits',
};

describe('identify', () => {
  it('a form email: the customer from Reply-To, the name and the phone from labelled lines', () => {
    const outcome = identify({ ctx: ctx(), rules: [formRule], patterns: [] });
    expect(outcome).toMatchObject({
      matched: [{ id: 'r1', name: 'App form' }],
      customerFrom: 'reply_to',
      customerEmail: { value: 'anna@example.test', trust: 'trusted' },
      customerName: 'Анна',
    });
    expect(outcome.found).toEqual([
      expect.objectContaining({ type: 'phone', value: '79000000001', trust: 'claimed', source: 'rule', ruleName: 'App form', evidence: 'Телефон: +7 (900) 000-00-01' }),
    ]);
  });

  it('a rule that does not match changes nothing; a disabled one is skipped; stop ends the list', () => {
    expect(identify({ ctx: ctx({ from: { email: 'anna@example.test', domain: 'example.test' } }), rules: [formRule], patterns: [] })).toMatchObject({ matched: [], customerFrom: 'sender', found: [] });
    expect(identify({ ctx: ctx(), rules: [{ ...formRule, enabled: false }], patterns: [] }).matched).toEqual([]);
    const second: IdentificationRuleLike = { ...formRule, id: 'r2', name: 'Second', customerFrom: 'sender', extract: [] };
    expect(identify({ ctx: ctx(), rules: [{ ...formRule, stop: true }, second], patterns: [] }).matched.map((m) => m.id)).toEqual(['r1']);
  });

  it('extracted_email takes the customer from the text with the extract trust; that email is not a claim', () => {
    const rule: IdentificationRuleLike = {
      ...formRule,
      customerFrom: 'extracted_email',
      extract: [{ identityType: 'email', source: 'body', pattern: 'Email:\\s*(\\S+)', trust: 'claimed' }],
    };
    const outcome = identify({ ctx: ctx({ reply_to: null }), rules: [rule], patterns: [] });
    expect(outcome.customerEmail).toEqual({ value: 'anna@example.test', trust: 'claimed' });
    expect(outcome.found).toEqual([]);
  });

  it('a header as the source and a header condition', () => {
    const rule: IdentificationRuleLike = {
      ...formRule,
      conditions: { field: 'header.x-form', op: 'eq', value: 'support' },
      customerFrom: 'sender',
      extract: [{ identityType: 'guest_id', source: 'header:X-Guest', pattern: '(\\d+)', trust: 'trusted' }],
    };
    expect(identify({ ctx: ctx({ header: { 'x-form': 'support', 'x-guest': '1542' } }), rules: [rule], patterns: [] }).found).toEqual([
      expect.objectContaining({ type: 'guest_id', value: '1542', trust: 'trusted' }),
    ]);
  });

  it('manifest patterns find claims in the subject and body; repeats count once, at most 5 per type', () => {
    const body = `Карта 700012345, ещё раз 700012345. Чек 1700012345.\n${Array.from({ length: 8 }, (_, i) => `70000000${i}`).join(' ')}`;
    const outcome = identify({ ctx: ctx({ subject: 'Карта 700099999', body }), rules: [], patterns: [cardPattern] });
    expect(outcome.found.map((f) => f.value)).toEqual(['700099999', '700012345', '700000000', '700000001', '700000002']);
    expect(outcome.found[0]).toMatchObject({ source: 'manifest', trust: 'claimed', integrationName: 'Coffee', evidence: 'Карта 700099999' });
  });
});

describe('findAll and occursIn', () => {
  it('findAll: the value group, group 1 or the whole match; an invalid pattern finds nothing', () => {
    expect(findAll('карта (\\d+)', 'Карта 123 и карта 456').map((m) => m.raw)).toEqual(['123', '456']);
    expect(findAll('\\d{3}', 'a 123 b').map((m) => m.raw)).toEqual(['123']);
    expect(findAll('(', 'text')).toEqual([]);
  });

  it('occursIn: digits split by separators, a phone by its last 10 digits, other values case-insensitively', () => {
    expect(occursIn('card_number', '700012345', 'моя карта 700 012 345, спасибо')).toBe(true);
    expect(occursIn('card_number', '700012345', 'чек 17000123456')).toBe(false);
    expect(occursIn('phone', '79123456789', 'звоните 8 (912) 345-67-89')).toBe(true);
    expect(occursIn('email', 'Anna@Example.test', 'пишите на anna@example.TEST')).toBe(true);
    expect(occursIn('card_number', '700012345', 'другой номер 700012346')).toBe(false);
  });
});
