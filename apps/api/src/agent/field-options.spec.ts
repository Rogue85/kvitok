import { describe, expect, it } from 'vitest';
import type { FieldDefinitionDto } from '@kvitok/shared';
import { checkFieldOptions, normalizeText, optionsPresentation, searchOptions } from './field-options';

const options = [
  { value: '512', label: 'Тверская, 12', group: 'Москва', agentHint: 'м. Пушкинская; ТЦ «Галерея»' },
  { value: '513', label: 'ТЦ «Кристалл»', group: 'Москва', agentHint: 'Каширское шоссе' },
  { value: '600', label: 'ТЦ «Тиара»', group: 'Казань' },
  { value: '601', label: 'Ёлки-Палки, 3', group: 'Казань' },
  { value: '700', label: 'Ленинский проспект, 30', group: 'Москва', archived: true },
];

describe('field options', () => {
  it('normalizes case, ё, quotes and punctuation', () => {
    expect(normalizeText('ТЦ «Кристалл», Ёлки')).toBe('тц кристалл елки');
  });

  it('search: label words weigh more than the group and hints; prefixes count', () => {
    expect(searchOptions(options, 'кристал').options.map((o) => o.value)).toEqual(['513']);
    expect(searchOptions(options, 'тц казань').options[0]!.value).toBe('600');
    expect(searchOptions(options, 'пушкинская').options.map((o) => o.value)).toEqual(['512']);
    expect(searchOptions(options, 'елки').options.map((o) => o.value)).toEqual(['601']);
  });

  it('search: an exact value comes first, archived options are never found, typos still match', () => {
    expect(searchOptions(options, '600').options[0]!.value).toBe('600');
    expect(searchOptions(options, 'ленинский').options).toEqual([]);
    expect(searchOptions(options, 'Тверcкая').options[0]!.value).toBe('512');
  });

  it('search: an empty query lists the active options; total counts all matches', () => {
    expect(searchOptions(options, '  ').total).toBe(4);
    expect(searchOptions(options, 'москва', 1)).toMatchObject({ total: 2, options: [expect.objectContaining({ group: 'Москва' })] });
  });

  it('presentation: auto by the number of active options, forced modes, none for other types', () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ value: String(i), label: `Shop ${i}` }));
    expect(optionsPresentation({ type: 'select', options, agentOptionsMode: 'auto' })).toBe('list');
    expect(optionsPresentation({ type: 'select', options: many, agentOptionsMode: 'auto' })).toBe('search');
    expect(optionsPresentation({ type: 'select', options: many, agentOptionsMode: 'list' })).toBe('list');
    expect(optionsPresentation({ type: 'multiselect', options, agentOptionsMode: 'search' })).toBe('search');
    expect(optionsPresentation({ type: 'text', options: [], agentOptionsMode: 'auto' })).toBeNull();
  });

  it('check: candidates only for a select — a text field or a field the agent was not offered drops them', () => {
    const fields = [
      { key: 'shop', type: 'select', options, agentOptionsMode: 'auto' },
      { key: 'receipt', type: 'text', options: [], agentOptionsMode: 'auto' },
    ] as unknown as FieldDefinitionDto[];
    const checked = checkFieldOptions(
      {
        shop: { value: null, confidence: 0.6, evidence: null, candidates: ['512', '999', '700', '513'] },
        receipt: { value: null, confidence: 0.5, evidence: null, candidates: ['0548', '0549'] },
        scoped: { value: 'x', confidence: 0.9, evidence: null, candidates: ['y'] },
      },
      fields,
    );
    // Unknown and archived candidates are dropped quietly.
    expect(checked.fields.shop).toMatchObject({ value: null, candidates: ['512', '513'] });
    expect(checked.fields.receipt).toEqual({ value: null, confidence: 0.5, evidence: null });
    expect(checked.fields.scoped).toEqual({ value: 'x', confidence: 0.9, evidence: null });
    expect(checked.problems).toEqual([]);
  });
});
