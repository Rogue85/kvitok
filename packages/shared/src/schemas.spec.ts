import { describe, expect, it } from 'vitest';
import {
  AddMemberSchema,
  CreateUserSchema,
  CreateWorkspaceSchema,
  LoginSchema,
  roleSatisfies,
  UpdateDepartmentSchema,
  UpdateFieldDefinitionSchema,
  UpdateIntegrationSchema,
  UpdateLlmProviderSchema,
  UpdatePlaybookSchema,
  UpdateRoutingRuleSchema,
  slugify,
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
  it('takes an existing user by id or invites a new person by email and name', () => {
    expect(AddMemberSchema.parse({ userId: 'u1', role: 'viewer' })).toEqual({ userId: 'u1', role: 'viewer' });
    expect(AddMemberSchema.parse({ email: ' A@B.co ', name: ' Анна ', role: 'operator' })).toEqual({ email: 'a@b.co', name: 'Анна', role: 'operator' });
  });

  it('never accepts a password from the admin', () => {
    expect(AddMemberSchema.parse({ email: 'a@b.co', name: 'A', role: 'operator', password: 'password123' })).not.toHaveProperty('password');
  });

  it('rejects an unknown role and an invitation without a name', () => {
    expect(AddMemberSchema.safeParse({ userId: 'u1', role: 'owner' }).success).toBe(false);
    expect(AddMemberSchema.safeParse({ email: 'a@b.co', role: 'operator' }).success).toBe(false);
  });
});

describe('CreateUserSchema', () => {
  it('rejects the same workspace twice', () => {
    const memberships = [
      { workspaceId: 'w1', role: 'admin' },
      { workspaceId: 'w1', role: 'viewer' },
    ];
    expect(CreateUserSchema.safeParse({ email: 'a@b.co', name: 'A', memberships }).success).toBe(false);
  });
});

describe('slugify', () => {
  it.each([
    ['Кофейня «Зёрна»', 'kofeynya-zerna'],
    ['Acme Coffee & Co.', 'acme-coffee-co'],
    ['Café Crème', 'cafe-creme'],
    ['  --Щука--  ', 'schuka'],
    ['!!!', ''],
  ])('%s → %s', (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });

  it('fits the slug length and never ends with a hyphen', () => {
    const slug = slugify(`${'a'.repeat(47)} b`);
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith('-')).toBe(false);
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
