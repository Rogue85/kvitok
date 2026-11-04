import { describe, expect, it } from 'vitest';
import { actionFormFields } from './actions.js';

describe('actionFormFields', () => {
  it('a flat schema as zod writes it: enum, integer without a real maximum, nullable string, number, defaults', () => {
    const fields = actionFormFields({
      type: 'object',
      properties: {
        basis: { type: 'string', enum: ['base_cashback', 'promo_cashback'] },
        amount: { type: 'integer', minimum: 1, maximum: 9007199254740991, description: 'Points' },
        transaction_id: { default: null, anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
        receipt_total: { type: 'number', exclusiveMinimum: 0 },
        notify: { type: ['boolean', 'null'], title: 'Notify the guest' },
      },
      required: ['basis', 'amount'],
    });
    expect(fields).toEqual([
      { name: 'basis', label: 'basis', description: null, required: true, nullable: false, kind: 'enum', options: ['base_cashback', 'promo_cashback'] },
      { name: 'amount', label: 'amount', description: 'Points', required: true, nullable: false, kind: 'integer', min: 1, max: null },
      { name: 'transaction_id', label: 'transaction_id', description: null, required: false, nullable: true, default: null, kind: 'string', maxLength: null },
      { name: 'receipt_total', label: 'receipt_total', description: null, required: false, nullable: false, kind: 'number', min: null, max: null },
      { name: 'notify', label: 'Notify the guest', description: null, required: false, nullable: true, kind: 'boolean' },
    ]);
  });

  it('what a flat form cannot show falls back to the JSON editor', () => {
    expect(actionFormFields({ type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } } })).toBeNull();
    expect(actionFormFields({ type: 'object', properties: { address: { type: 'object', properties: {} } } })).toBeNull();
    expect(actionFormFields({ type: 'object', oneOf: [{ required: ['a'] }, { required: ['b'] }], properties: {} })).toBeNull();
    expect(actionFormFields({ type: 'object', properties: { id: { anyOf: [{ type: 'string' }, { type: 'integer' }] } } })).toBeNull();
    // A select cannot offer an empty string as an option.
    expect(actionFormFields({ type: 'object', properties: { size: { type: 'string', enum: ['', 'large'] } } })).toBeNull();
    expect(actionFormFields({ type: 'object' })).toEqual([]);
  });
});
