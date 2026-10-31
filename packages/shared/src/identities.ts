import { t } from '@kvitok/i18n';
import { z } from 'zod';

/** Customer identity types are defined by the workspace: email, phone, employee_id, card_number… */
export const IdentityTypeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9_]{0,31}$/, { error: () => t('validation.identifier') });

export const IdentitiesSchema = z.record(IdentityTypeSchema, z.string().trim().min(1).max(320));

/** How values of an identity type compare: digits only (phones, cards), lowercase (emails), as is. */
export const IDENTITY_NORMALIZATIONS = ['digits', 'lowercase', 'none'] as const;
export type IdentityNormalization = (typeof IDENTITY_NORMALIZATIONS)[number];

/** Normalizes a value to the form customers are looked up by. Without an explicit mode: email — lowercase, phone — digits. */
export function normalizeIdentity(type: string, value: string, mode?: IdentityNormalization | null): string {
  const trimmed = value.trim();
  const effective = mode ?? (type === 'email' ? 'lowercase' : type === 'phone' ? 'digits' : 'none');
  if (effective === 'lowercase') {
    return trimmed.toLowerCase();
  }
  if (effective === 'digits') {
    const digits = trimmed.replace(/\D+/g, '');
    return digits === '' ? trimmed : digits;
  }
  return trimmed;
}

/** An identity type an integration resolves by, from its manifest. */
export interface IdentityTypeDto {
  type: string;
  label: string | null;
  /** A regular expression that finds such values in message text. */
  pattern: string | null;
  normalize: IdentityNormalization | null;
  description: string | null;
}
