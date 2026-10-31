import { describe, expect, it } from 'vitest';
import { ContextResponseSchema, ManifestSchema, ResolveResponseSchema, ValidateResponseSchema } from './schemas.js';

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
