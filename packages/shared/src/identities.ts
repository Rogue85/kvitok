import { t } from '@kvitok/i18n';
import { z } from 'zod';

/** Customer identity types are defined by the workspace: email, phone, employee_id, card_number… */
export const IdentityTypeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9_]{0,31}$/, { error: () => t('validation.identifier') });

export const IdentitiesSchema = z.record(IdentityTypeSchema, z.string().trim().min(1).max(320));

/** Normalizes a value to the form customers are looked up by. */
export function normalizeIdentity(type: string, value: string): string {
  const trimmed = value.trim();
  if (type === 'email') {
    return trimmed.toLowerCase();
  }
  if (type === 'phone') {
    const digits = trimmed.replace(/\D+/g, '');
    return digits === '' ? trimmed : digits;
  }
  return trimmed;
}
