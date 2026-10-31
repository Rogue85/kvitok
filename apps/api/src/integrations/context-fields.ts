import type { FieldDefinitionDto, FieldMeta, FieldValues } from '@kvitok/shared';
import { json } from '../common/json';
import { applyFieldValues } from '../fields/field-values';
import type { Prisma } from '../generated/prisma/client';

/**
 * Customer attributes from the backend card (`/context.fields`) → the customer's fields: keys through the integration's
 * mapping (or as they are, when a customer field has the same key), written with `source: integration`. An operator's pin
 * wins. Values this integration wrote for another of its customers (before a relink) are cleared.
 */
export async function applyContextFields(
  db: Pick<Prisma.TransactionClient, 'customer'>,
  params: {
    customer: { id: string; fields: unknown; fieldMeta: unknown };
    integration: { id: string; fieldMapping: unknown };
    customerRef: string;
    fields: Record<string, unknown> | undefined;
    definitions: FieldDefinitionDto[];
  },
): Promise<string[]> {
  const definitions = params.definitions.filter((d) => d.entity === 'customer' && !d.archived);
  const known = new Set(definitions.map((d) => d.key));
  const mapping = (params.integration.fieldMapping ?? {}) as Record<string, string>;
  const values = (params.customer.fields ?? {}) as FieldValues;
  const meta = (params.customer.fieldMeta ?? {}) as FieldMeta;

  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params.fields ?? {})) {
    const target = mapping[key] ?? key;
    if (known.has(target)) input[target] = value;
  }
  for (const [key, entry] of Object.entries(meta)) {
    if (entry.source === 'integration' && entry.integrationId === params.integration.id && entry.customerRef !== params.customerRef && !(key in input)) {
      input[key] = null;
    }
  }
  if (Object.keys(input).length === 0) return [];

  const applied = applyFieldValues({
    definitions,
    values,
    meta,
    input,
    source: 'integration',
    actor: { integrationId: params.integration.id, customerRef: params.customerRef },
  });
  if (applied.changes.length === 0) return [];
  await db.customer.update({ where: { id: params.customer.id }, data: { fields: json(applied.values), fieldMeta: json(applied.meta) } });
  return applied.changes.map((c) => c.key);
}
