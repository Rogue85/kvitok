import { describe, expect, it } from 'vitest';
import { ActionRequestSchema, ContextResponseSchema, ManifestSchema, OptionSetResponseSchema, ResolveResponseSchema, ValidateResponseSchema } from './schemas.js';

const tool = {
  name: 'get_coupons',
  title: 'Guest coupons',
  description: 'Active and used coupons',
  input_schema: { type: 'object', properties: { include_used: { type: 'boolean' } } },
};

describe('protocol schemas', () => {
  it('manifest: defaults of tools and actions', () => {
    const manifest = ManifestSchema.parse({ protocol_version: 1, name: 'coffee', title: 'Coffee shop', tools: [tool] });
    expect(manifest.tools[0]).toMatchObject({ display: 'json', requires_customer: true, cache_ttl_seconds: 300, examples: [] });
    expect(manifest).toMatchObject({ actions: [], playbooks: [], suggested_departments: [], instructions: '' });
  });

  it('manifest: action audience defaults to both, accepts operator-only and rejects empty or duplicate lists', () => {
    const action = { name: 'adjust_points', title: 'Adjust points', description: 'A goodwill credit', input_schema: { type: 'object' } };
    const parse = (extra: object) => ManifestSchema.safeParse({ protocol_version: 1, name: 'coffee', title: 'C', actions: [{ ...action, ...extra }] });
    expect(parse({}).data?.actions[0]?.audience).toEqual(['agent', 'operator']);
    expect(parse({ audience: ['operator'] }).data?.actions[0]?.audience).toEqual(['operator']);
    expect(parse({ audience: [] }).success).toBe(false);
    expect(parse({ audience: ['operator', 'operator'] }).success).toBe(false);
    expect(parse({ audience: ['robot'] }).success).toBe(false);
  });

  it('action request: the execution context is optional and unknown fields are dropped', () => {
    expect(ActionRequestSchema.parse({ customer_ref: 'g1', params: {}, extra: 1 })).toEqual({ customer_ref: 'g1', params: {} });
    const context = { source: 'operator', ticket: 'T-482', operator: { email: 'egor@example.com' } };
    expect(ActionRequestSchema.parse({ customer_ref: 'g1', params: {}, context }).context).toEqual(context);
  });

  it('manifest: duplicate names, a foreign version and a non-object input_schema are rejected', () => {
    expect(ManifestSchema.safeParse({ protocol_version: 1, name: 'coffee', title: 'C', tools: [tool, tool] }).success).toBe(false);
    expect(ManifestSchema.safeParse({ protocol_version: 2, name: 'coffee', title: 'C' }).success).toBe(false);
    expect(ManifestSchema.safeParse({ protocol_version: 1, name: 'coffee', title: 'C', tools: [{ ...tool, input_schema: { type: 'array' } }] }).success).toBe(false);
    expect(ManifestSchema.safeParse({ protocol_version: 1, name: 'Coffee-Shop', title: 'C' }).success).toBe(false);
  });

  it('manifest: identity types as names or definitions with a pattern', () => {
    const manifest = ManifestSchema.parse({
      protocol_version: 1,
      name: 'coffee',
      title: 'C',
      identity_types: ['phone', { type: 'card_number', label: 'Loyalty card', pattern: '\\b70\\d{7}\\b', normalize: 'digits' }],
    });
    expect(manifest.identity_types).toEqual([{ type: 'phone' }, { type: 'card_number', label: 'Loyalty card', pattern: '\\b70\\d{7}\\b', normalize: 'digits' }]);
    // Parsing the stored (already transformed) manifest again gives the same result.
    expect(ManifestSchema.parse(manifest).identity_types).toEqual(manifest.identity_types);
    expect(ManifestSchema.safeParse({ protocol_version: 1, name: 'coffee', title: 'C', identity_types: [{ type: 'card_number', pattern: '(' }] }).success).toBe(false);
    expect(ManifestSchema.safeParse({ protocol_version: 1, name: 'coffee', title: 'C', identity_types: ['phone', { type: 'phone' }] }).success).toBe(false);
  });

  it('manifest: option sets with unique names', () => {
    const set = { name: 'places', title: 'Coffee shops' };
    expect(ManifestSchema.parse({ protocol_version: 1, name: 'coffee', title: 'C', option_sets: [set] }).option_sets).toEqual([{ ...set, description: '' }]);
    expect(ManifestSchema.parse({ protocol_version: 1, name: 'coffee', title: 'C' }).option_sets).toEqual([]);
    expect(ManifestSchema.safeParse({ protocol_version: 1, name: 'coffee', title: 'C', option_sets: [set, set] }).success).toBe(false);
  });

  it('option set: active by default, values unique and non-empty', () => {
    const parsed = OptionSetResponseSchema.parse({ options: [{ value: '512', label: 'Tverskaya St, 12', group: 'Moscow' }, { value: '77', label: 'Leninsky Ave', active: false }] });
    expect(parsed.options.map((o) => o.active)).toEqual([true, false]);
    expect(OptionSetResponseSchema.safeParse({ options: [{ value: '1', label: 'A' }, { value: '1', label: 'B' }] }).success).toBe(false);
    expect(OptionSetResponseSchema.safeParse({ options: [{ value: ' ', label: 'A' }] }).success).toBe(false);
  });

  it('resolve: matched_by in found and in candidates', () => {
    expect(ResolveResponseSchema.parse({ status: 'found', customer_ref: 'g1', matched_by: ['card_number'] })).toMatchObject({ matched_by: ['card_number'] });
    const ambiguous = ResolveResponseSchema.parse({
      status: 'ambiguous',
      candidates: [
        { customer_ref: 'g1', display_name: 'Anna', matched_by: ['email'] },
        { customer_ref: 'g2', display_name: 'Maria', matched_by: ['card_number'] },
      ],
    });
    expect(ambiguous).toMatchObject({ candidates: [{ matched_by: ['email'] }, { matched_by: ['card_number'] }] });
  });

  it('context: fields are scalars or lists of strings', () => {
    expect(ContextResponseSchema.parse({ fields: { tier: 'gold', cashback_percent: 7, vip: true, tags: ['a'] } }).fields).toEqual({ tier: 'gold', cashback_percent: 7, vip: true, tags: ['a'] });
    expect(ContextResponseSchema.safeParse({ fields: { profile: { nested: 1 } } }).success).toBe(false);
  });

  it('resolve: found requires customer_ref, ambiguous at least two candidates', () => {
    expect(ResolveResponseSchema.safeParse({ status: 'found' }).success).toBe(false);
    expect(ResolveResponseSchema.safeParse({ status: 'ambiguous', candidates: [{ customer_ref: 'g1', display_name: 'Anna' }] }).success).toBe(false);
    expect(ResolveResponseSchema.parse({ status: 'not_found' })).toEqual({ status: 'not_found' });
  });

  it('validate: warnings and errors are empty by default', () => {
    expect(ValidateResponseSchema.parse({ ok: true })).toEqual({ ok: true, warnings: [], errors: [] });
  });
});
