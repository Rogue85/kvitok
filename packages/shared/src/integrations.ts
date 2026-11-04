import { t } from '@kvitok/i18n';
import { z } from 'zod';
import { IntegrationIdentificationSchema, type ClaimLinking, type IdentityClaimDto, type PendingIdentification } from './identification.js';
import type { IdentityTypeDto } from './identities.js';
import { patchOf } from './patch.js';

/* Integrations: backends speaking the Support Action Protocol (docs/protocol.md). */

const IntegrationBase = z.object({
  name: z.string().trim().min(1).max(120),
  baseUrl: z.url({ protocol: /^https?$/ }),
  enabled: z.boolean().default(true),
});

export const CreateIntegrationSchema = IntegrationBase.extend({
  /** Shared secret for signing requests; shown only while being entered. */
  secret: z.string().min(16, { error: () => t('validation.minLength', { min: 16 }) }).max(500),
});
export type CreateIntegrationInput = z.input<typeof CreateIntegrationSchema>;

export const UpdateIntegrationSchema = patchOf(IntegrationBase)
  .extend({
    /** Not passed — the current one stays. */
    secret: z.string().min(16, { error: () => t('validation.minLength', { min: 16 }) }).max(500).optional(),
  })
  .extend(IntegrationIdentificationSchema.partial().shape);
export type UpdateIntegrationInput = z.input<typeof UpdateIntegrationSchema>;

export const SyncIntegrationSchema = z.object({
  /** true — load the whole manifest, without If-None-Match. */
  force: z.boolean().default(false),
});

export const ImportDepartmentsSchema = z.object({
  keys: z.array(z.string().min(1).max(64)).min(1).max(50),
});
export type ImportDepartmentsInput = z.infer<typeof ImportDepartmentsSchema>;

export interface IntegrationToolDto {
  name: string;
  title: string;
  description: string;
  display: string;
  requiresCustomer: boolean;
  cacheTtlSeconds: number;
  /** Parameters from input_schema: name, type, whether required. */
  params: Array<{ name: string; type: string; required: boolean; description: string | null }>;
}

export interface IntegrationActionDto {
  name: string;
  title: string;
  description: string;
  requiresApproval: boolean;
  params: IntegrationToolDto['params'];
}

export interface IntegrationManifestDto {
  name: string;
  title: string;
  protocolVersion: number;
  identityTypes: IdentityTypeDto[];
  instructions: string;
  tools: IntegrationToolDto[];
  actions: IntegrationActionDto[];
  playbookKeys: string[];
  suggestedDepartments: Array<{ key: string; title: string; description: string; examples: string[]; exists: boolean }>;
}

export interface IntegrationDto {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  hasSecret: boolean;
  /** When the manifest was last fetched or confirmed (304). */
  syncedAt: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  manifestEtag: string | null;
  manifest: IntegrationManifestDto | null;
  claimLinking: ClaimLinking;
  textIdentities: boolean;
  fieldMapping: Record<string, string>;
  /** Directories from the manifest with their sync state. */
  optionSets: OptionSetDto[];
}

/** A backend directory for select fields (`option_sets` in the manifest). */
export interface OptionSetDto {
  id: string;
  integrationId: string;
  integrationName: string;
  name: string;
  title: string;
  description: string;
  /** All options, archived ones included. */
  size: number;
  activeSize: number;
  syncedAt: string | null;
  lastSyncError: string | null;
  /** The manifest no longer declares the set: bound fields keep its last options. */
  removed: boolean;
  /** Keys of the fields bound to the set. */
  fieldKeys: string[];
}

export interface OptionSetSyncDto {
  name: string;
  status: 'updated' | 'not_modified' | 'error';
  error?: string;
  added: number;
  changed: number;
  archived: number;
  restored: number;
}

export interface IntegrationSyncResultDto {
  status: 'updated' | 'not_modified' | 'error';
  error?: string;
  playbooks?: { added: string[]; updated: string[]; removed: string[]; skipped: Array<{ key: string; reason: string }> };
  optionSets?: OptionSetSyncDto[];
}

/* Customer in an external system */

export const CUSTOMER_LINK_STATUSES = ['found', 'not_found', 'ambiguous', 'unresolved'] as const;
export type CustomerLinkStatus = (typeof CUSTOMER_LINK_STATUSES)[number];

export interface CustomerLinkDto {
  integrationId: string;
  integrationName: string;
  /** unresolved — not searched yet (the agent searches before a run). */
  status: CustomerLinkStatus;
  customerRef: string | null;
  displayName: string | null;
  candidates: Array<{ customerRef: string; displayName: string; hint: string | null }>;
  /** manual — chosen by an operator: never revised automatically; claim — found by data from the messages. */
  source: 'auto' | 'manual' | 'claim' | null;
  /** false — found by identities people typed and not confirmed: actions are locked. */
  confirmed: boolean;
  /** Identity types the backend matched the customer by. */
  matchedBy: string[];
  /** A decision waiting for the operator. */
  pending: PendingIdentification | null;
  resolvedAt: string | null;
  lastError: string | null;
  /** Identities the backend can search by. */
  identityTypes: IdentityTypeDto[];
  /** Identities found in this ticket's messages. */
  claims: IdentityClaimDto[];
}

/**
 * Manual link: pick a candidate (`customerRef`) or search by the entered identities.
 * An empty body searches again by the customer's contacts.
 */
export const LinkCustomerSchema = z
  .object({
    customerRef: z.string().trim().min(1).max(200).optional(),
    identities: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), z.string().trim().min(1).max(320)).optional(),
  })
  .refine((v) => !(v.customerRef && v.identities), { error: () => t('validation.customerRefOrIdentities') })
  .refine((v) => v.identities === undefined || Object.keys(v.identities).length > 0, { error: () => t('validation.identityRequired'), path: ['identities'] });
export type LinkCustomerInput = z.infer<typeof LinkCustomerSchema>;
