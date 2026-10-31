import { t } from '@kvitok/i18n';
import { z } from 'zod';
import { IdentityTypeSchema } from './identities.js';
import { patchOf } from './patch.js';
import { RuleConditionSchema, type RuleCondition } from './rules.js';

/* Customer identification: who the customer of a message is and which identities it carries (design.md, "Customer identification"). */

/** trusted — the source vouches for the value; claimed — a person typed it. */
export const IDENTITY_TRUST = ['trusted', 'claimed'] as const;
export type IdentityTrust = (typeof IDENTITY_TRUST)[number];

export const CLAIM_SOURCES = ['sender', 'api', 'rule', 'manifest', 'agent', 'operator'] as const;
export type ClaimSource = (typeof CLAIM_SOURCES)[number];

/** pending — not resolved yet; matched — a customer was found and waits for a decision; confirmed / rejected — decided. */
export const CLAIM_STATUSES = ['pending', 'matched', 'not_found', 'confirmed', 'rejected'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** Who the customer of the message is: the sender, Reply-To (a form email) or the email found in the text. */
export const CUSTOMER_FROM = ['sender', 'reply_to', 'extracted_email'] as const;
export type CustomerFrom = (typeof CUSTOMER_FROM)[number];

/** What to do when the backend finds a customer only by identities people typed. */
export const CLAIM_LINKING = ['off', 'suggest', 'corroborated', 'auto'] as const;
export type ClaimLinking = (typeof CLAIM_LINKING)[number];

/** Whether the email `From` is trusted always or only when the receiving server authenticated it (DMARC/DKIM). */
export const TRUST_SENDER = ['always', 'authenticated'] as const;
export type TrustSender = (typeof TRUST_SENDER)[number];

/** A pseudo identity type: the extracted value becomes the customer name. */
export const NAME_IDENTITY = 'name';

export const ExtractSourceSchema = z
  .string()
  .trim()
  .regex(/^(subject|body|header:[A-Za-z0-9-]{1,64})$/, { error: () => t('validation.extractSource') });

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern, 'gi');
    return true;
  } catch {
    return false;
  }
}

export const IdentityExtractSchema = z.object({
  identityType: IdentityTypeSchema,
  source: ExtractSourceSchema,
  /** The value is the named group `value`, otherwise group 1, otherwise the whole match. */
  pattern: z
    .string()
    .min(1)
    .max(500)
    .refine(compiles, { error: () => t('validation.invalidRegex') }),
  trust: z.enum(IDENTITY_TRUST).default('claimed'),
});
export type IdentityExtract = z.infer<typeof IdentityExtractSchema>;

const IdentificationRuleBase = z.object({
  name: z.string().trim().min(1).max(200),
  conditions: RuleConditionSchema,
  customerFrom: z.enum(CUSTOMER_FROM).default('sender'),
  extract: z.array(IdentityExtractSchema).max(20).default([]),
  stop: z.boolean().default(false),
  enabled: z.boolean().default(true),
  position: z.number().int().default(0),
});

function checkCustomerFrom(value: { customerFrom?: CustomerFrom; extract?: IdentityExtract[] }, ctx: z.RefinementCtx): void {
  if (value.customerFrom === 'extracted_email' && value.extract !== undefined && !value.extract.some((e) => e.identityType === 'email')) {
    ctx.addIssue({ code: 'custom', path: ['extract'], message: t('validation.extractEmailRequired') });
  }
}

export const CreateIdentificationRuleSchema = IdentificationRuleBase.superRefine(checkCustomerFrom);
export type CreateIdentificationRuleInput = z.input<typeof CreateIdentificationRuleSchema>;
export const UpdateIdentificationRuleSchema = patchOf(IdentificationRuleBase).superRefine(checkCustomerFrom);
export type UpdateIdentificationRuleInput = z.input<typeof UpdateIdentificationRuleSchema>;

export interface IdentificationRuleDto {
  id: string;
  name: string;
  position: number;
  conditions: RuleCondition;
  customerFrom: CustomerFrom;
  extract: IdentityExtract[];
  stop: boolean;
  enabled: boolean;
}

export const IdentificationSettingsSchema = z.object({
  trustSender: z.enum(TRUST_SENDER),
});
export type IdentificationSettingsDto = z.infer<typeof IdentificationSettingsSchema>;

/** One identity found in a message. */
export interface FoundIdentityDto {
  type: string;
  value: string;
  trust: IdentityTrust;
  source: ClaimSource;
  ruleName: string | null;
  integrationName: string | null;
}

/** "Check on ticket": what the identification of the ticket's last customer message gives, without writing anything. */
export interface IdentificationCheckDto {
  matched: Array<{ ruleId: string; name: string }>;
  customerFrom: CustomerFrom;
  customer: { email: string | null; name: string | null };
  identities: FoundIdentityDto[];
  context: Record<string, unknown>;
}

export interface IdentityClaimDto {
  id: string;
  type: string;
  value: string;
  source: ClaimSource;
  trust: IdentityTrust;
  status: ClaimStatus;
  ruleName: string | null;
  evidence: string | null;
  messageId: string | null;
  createdAt: string;
}

/** A decision waiting for the operator, stored on the customer link. */
export const PENDING_KINDS = ['suggestion', 'conflict', 'candidates', 'confirm'] as const;
export type PendingKind = (typeof PENDING_KINDS)[number];

export interface PendingOption {
  customerRef: string;
  displayName: string | null;
  hint: string | null;
  /** Identity types that point to this customer. */
  matchedBy: string[];
  /** The customer the link pointed to before (in a conflict: the one found by trusted identities). */
  current: boolean;
}

export interface PendingIdentification {
  kind: PendingKind;
  ticketId: string;
  /** The `customer_identification` event that shows the card in the timeline. */
  eventId: string;
  claimIds: string[];
  options: PendingOption[];
  /** The link before an automatic unconfirmed link: "not this customer" returns to it. */
  previous: { status: string; customerRef: string | null; displayName: string | null; candidates: unknown; matchedBy: string[] } | null;
  createdAt: string;
}

/** The operator's answer to an identification card: this customer, or none of the offered. */
export const DecideIdentificationSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('choose'), customerRef: z.string().trim().min(1).max(200) }),
  z.object({ decision: z.literal('reject') }),
]);
export type DecideIdentificationInput = z.infer<typeof DecideIdentificationSchema>;

/** Integration settings for customer identification. */
export const IntegrationIdentificationSchema = z.object({
  claimLinking: z.enum(CLAIM_LINKING),
  textIdentities: z.boolean(),
  fieldMapping: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.string().regex(/^[a-z][a-z0-9_]{0,47}$/)),
});
