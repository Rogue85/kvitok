import { describe, expect, it } from 'vitest';
import { CreateFieldDefinitionSchema, fieldValueSchema, isEmptyFieldValue, type FieldDefinitionDto } from './fields.js';
import { normalizeIdentity } from './identities.js';

const def = (overrides: Partial<FieldDefinitionDto>) =>
  ({ type: 'text', options: [], validation: {}, ...overrides }) as Pick<FieldDefinitionDto, 'type' | 'options' | 'validation'>;

describe('fieldValueSchema', () => {
  it('text: trims spaces, checks pattern and length', () => {
    const schema = fieldValueSchema(def({ type: 'text', validation: { pattern: '^\\d{3}$', maxLength: 3 } }));
    expect(schema.parse(' 214 ')).toBe('214');
    expect(schema.safeParse('21a').success).toBe(false);
    expect(schema.safeParse('').success).toBe(false);
  });

  it('number: accepts numbers and numeric strings, checks integer and range', () => {
    const schema = fieldValueSchema(def({ type: 'number', validation: { integer: true, min: 100, max: 999 } }));
    expect(schema.parse('214')).toBe(214);
    expect(schema.parse(500)).toBe(500);
    expect(schema.safeParse('21.5').success).toBe(false);
    expect(schema.safeParse(50).success).toBe(false);
    expect(schema.safeParse('abc').success).toBe(false);
  });

  it('boolean: accepts true/false as strings', () => {
    const schema = fieldValueSchema(def({ type: 'boolean' }));
    expect(schema.parse('true')).toBe(true);
    expect(schema.parse(false)).toBe(false);
    expect(schema.safeParse('yes').success).toBe(false);
  });

  it('select and multiselect: only option values', () => {
    const options = [
      { value: 'laptop', label: 'Laptop' },
      { value: 'printer', label: 'Printer' },
    ];
    expect(fieldValueSchema(def({ type: 'select', options })).safeParse('phone').success).toBe(false);
    // An archived option cannot be chosen anew, but the stored value keeps it.
    const retired = [...options, { value: 'fax', label: 'Fax', archived: true }];
    expect(fieldValueSchema(def({ type: 'select', options: retired })).safeParse('fax').success).toBe(false);
    expect(fieldValueSchema(def({ type: 'select', options: retired }), 'fax').safeParse('fax').success).toBe(true);
    expect(fieldValueSchema(def({ type: 'multiselect', options: retired }), ['fax']).parse(['fax', 'laptop'])).toEqual(['fax', 'laptop']);
    expect(fieldValueSchema(def({ type: 'multiselect', options: retired }), ['laptop']).safeParse(['fax']).success).toBe(false);
    expect(fieldValueSchema(def({ type: 'multiselect', options })).parse(['laptop', 'laptop', 'printer'])).toEqual([
      'laptop',
      'printer',
    ]);
  });

  it('date, datetime, email, phone, url', () => {
    expect(fieldValueSchema(def({ type: 'date' })).safeParse('2026-10-31').success).toBe(true);
    expect(fieldValueSchema(def({ type: 'date' })).safeParse('31.10.2026').success).toBe(false);
    expect(fieldValueSchema(def({ type: 'datetime' })).safeParse('2026-10-31T10:00:00+03:00').success).toBe(true);
    expect(fieldValueSchema(def({ type: 'email' })).parse(' A@B.CO ')).toBe('a@b.co');
    expect(fieldValueSchema(def({ type: 'phone' })).safeParse('+7 (999) 123-45-67').success).toBe(true);
    expect(fieldValueSchema(def({ type: 'url' })).safeParse('not a url').success).toBe(false);
  });
});

describe('CreateFieldDefinitionSchema', () => {
  it('requires options for select and unique values', () => {
    expect(CreateFieldDefinitionSchema.safeParse({ entity: 'ticket', key: 'kind', label: 'Kind', type: 'select' }).success).toBe(false);
    const duplicate = CreateFieldDefinitionSchema.safeParse({
      entity: 'ticket',
      key: 'kind',
      label: 'Kind',
      type: 'select',
      options: [
        { value: 'a', label: 'A' },
        { value: 'a', label: 'A2' },
      ],
    });
    expect(duplicate.success).toBe(false);
  });

  it('a select bound to an option set needs no options; only lists can be bound', () => {
    expect(CreateFieldDefinitionSchema.safeParse({ entity: 'ticket', key: 'shop', label: 'Shop', type: 'select', optionSetId: 'set1' }).success).toBe(true);
    expect(CreateFieldDefinitionSchema.safeParse({ entity: 'ticket', key: 'shop', label: 'Shop', type: 'text', optionSetId: 'set1' }).success).toBe(false);
  });

  it('takes a whole directory as its own options: up to 1,000 that can be chosen, archived ones on top', () => {
    const options = (count: number, archived = false) =>
      Array.from({ length: count }, (_, i) => ({ value: `${archived ? 'a' : 'v'}${i}`, label: `Shop ${i}`, ...(archived ? { archived: true } : {}) }));
    const field = (list: unknown[]) => CreateFieldDefinitionSchema.safeParse({ entity: 'ticket', key: 'shop', label: 'Shop', type: 'select', options: list });
    expect(field([...options(1000), ...options(300, true)]).success).toBe(true);
    expect(field(options(1001)).success).toBe(false);
  });

  it('checks the key format and the regular expression', () => {
    expect(CreateFieldDefinitionSchema.safeParse({ entity: 'ticket', key: 'Dept', label: 'X', type: 'text' }).success).toBe(false);
    expect(
      CreateFieldDefinitionSchema.safeParse({ entity: 'ticket', key: 'dept', label: 'X', type: 'text', validation: { pattern: '(' } })
        .success,
    ).toBe(false);
  });
});

describe('helpers', () => {
  it('isEmptyFieldValue', () => {
    expect([undefined, null, '', []].every(isEmptyFieldValue)).toBe(true);
    expect([0, false, 'x', ['a']].some(isEmptyFieldValue)).toBe(false);
  });

  it('normalizeIdentity', () => {
    expect(normalizeIdentity('email', ' Ivan@Mail.RU ')).toBe('ivan@mail.ru');
    expect(normalizeIdentity('phone', '+7 (999) 123-45-67')).toBe('79991234567');
    expect(normalizeIdentity('employee_id', ' E-15 ')).toBe('E-15');
  });
});
