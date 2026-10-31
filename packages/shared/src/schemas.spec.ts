import { describe, expect, it } from 'vitest';
import {
  AddMemberSchema,
  CreateWorkspaceSchema,
  LoginSchema,
  roleSatisfies,
  UpdateDepartmentSchema,
  UpdateFieldDefinitionSchema,
  UpdateIntegrationSchema,
  UpdateLlmProviderSchema,
  UpdatePlaybookSchema,
  UpdateRoutingRuleSchema,
} from './index.js';

describe('LoginSchema', () => {
  it('normalizes email', () => {
    expect(LoginSchema.parse({ email: '  Admin@Example.COM ', password: 'x' }).email).toBe('admin@example.com');
  });

  it('rejects an invalid email', () => {
    expect(LoginSchema.safeParse({ email: 'nope', password: 'x' }).success).toBe(false);
  });
});

describe('CreateWorkspaceSchema', () => {
  it('accepts a slug of Latin letters and hyphens', () => {
    expect(CreateWorkspaceSchema.parse({ name: 'Acme', slug: 'Acme-Coffee' }).slug).toBe('acme-coffee');
  });

  it.each(['-bad', 'bad-', 'пробел', 'a', 'a__b'])('rejects slug %s', (slug) => {
    expect(CreateWorkspaceSchema.safeParse({ name: 'X', slug }).success).toBe(false);
  });
});

describe('AddMemberSchema', () => {
  it('requires a password of at least 8 characters', () => {
    expect(AddMemberSchema.safeParse({ email: 'a@b.co', role: 'operator', password: 'short' }).success).toBe(false);
  });

  it('rejects an unknown role', () => {
    expect(AddMemberSchema.safeParse({ email: 'a@b.co', role: 'owner' }).success).toBe(false);
  });
});

describe('roleSatisfies', () => {
  it('admin satisfies any role, viewer only viewer', () => {
    expect(roleSatisfies('admin', 'operator')).toBe(true);
    expect(roleSatisfies('operator', 'admin')).toBe(false);
    expect(roleSatisfies('viewer', 'viewer')).toBe(true);
    expect(roleSatisfies('viewer', 'operator')).toBe(false);
  });
});

describe('PATCH schemas', () => {
  it('do not fill defaults into omitted fields', () => {
    expect(UpdateDepartmentSchema.parse({ title: 'Checkout' })).toEqual({ title: 'Checkout' });
    expect(UpdatePlaybookSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(UpdateLlmProviderSchema.parse({ name: 'OpenAI' })).toEqual({ name: 'OpenAI' });
    expect(UpdateFieldDefinitionSchema.parse({ label: 'Receipt' })).toEqual({ label: 'Receipt' });
    expect(UpdateRoutingRuleSchema.parse({ name: 'VIP' })).toEqual({ name: 'VIP' });
    expect(UpdateIntegrationSchema.parse({ name: 'Acme' })).toEqual({ name: 'Acme' });
  });

  it('still validate the passed fields', () => {
    expect(UpdateDepartmentSchema.safeParse({ examples: [''] }).success).toBe(false);
    expect(UpdatePlaybookSchema.parse({ departmentId: null })).toEqual({ departmentId: null });
  });
});
