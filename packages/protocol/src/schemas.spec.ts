import { describe, expect, it } from 'vitest';
import { ManifestSchema, ResolveResponseSchema, ValidateResponseSchema } from './schemas.js';

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

  it('resolve: found requires customer_ref, ambiguous at least two candidates', () => {
    expect(ResolveResponseSchema.safeParse({ status: 'found' }).success).toBe(false);
    expect(ResolveResponseSchema.safeParse({ status: 'ambiguous', candidates: [{ customer_ref: 'g1', display_name: 'Anna' }] }).success).toBe(false);
    expect(ResolveResponseSchema.parse({ status: 'not_found' })).toEqual({ status: 'not_found' });
  });

  it('validate: warnings and errors are empty by default', () => {
    expect(ValidateResponseSchema.parse({ ok: true })).toEqual({ ok: true, warnings: [], errors: [] });
  });
});
