import { Injectable } from '@nestjs/common';
import { normalizeIdentity, type CustomerDto, type FieldMeta, type FieldValues } from '@kvitok/shared';
import { newId } from '../common/ids';
import type { Customer, CustomerIdentity, Prisma } from '../generated/prisma/client';

export interface CustomerInput {
  name?: string | null;
  identities: Record<string, string>;
}

@Injectable()
export class CustomersService {
  /**
   * Finds a customer by any of the identities or creates a new one.
   * Identities that already belong to another customer are not moved: automatic merging is dangerous.
   */
  async resolve(db: Prisma.TransactionClient, workspaceId: string, input: CustomerInput): Promise<Customer | null> {
    const pairs = Object.entries(input.identities)
      .map(([type, value]) => ({ type, value: normalizeIdentity(type, value) }))
      .filter((p) => p.value !== '');
    const name = input.name?.trim() || null;

    if (pairs.length === 0 && name === null) {
      return null;
    }

    const existing =
      pairs.length === 0
        ? []
        : await db.customerIdentity.findMany({
            where: { workspaceId, OR: pairs.map((p) => ({ type: p.type, value: p.value })) },
            orderBy: { createdAt: 'asc' },
          });

    let customer: Customer;
    const first = existing[0];
    if (first === undefined) {
      customer = await db.customer.create({ data: { id: newId(), workspaceId, name } });
    } else {
      customer = await db.customer.findUniqueOrThrow({ where: { id: first.customerId } });
      if (customer.name === null && name !== null) {
        customer = await db.customer.update({ where: { id: customer.id }, data: { name } });
      }
    }

    const known = new Set(existing.map((i) => `${i.type}\u0000${i.value}`));
    const missing = pairs.filter((p) => !known.has(`${p.type}\u0000${p.value}`));
    if (missing.length > 0) {
      await db.customerIdentity.createMany({
        data: missing.map((p) => ({ id: newId(), workspaceId, customerId: customer.id, type: p.type, value: p.value })),
        skipDuplicates: true,
      });
    }

    return customer;
  }
}

export function toCustomerDto(customer: Customer & { identities: CustomerIdentity[] }): CustomerDto {
  return {
    id: customer.id,
    name: customer.name,
    identities: customer.identities.map((i) => ({ type: i.type, value: i.value })),
    fields: customer.fields as FieldValues,
    fieldMeta: customer.fieldMeta as unknown as FieldMeta,
  };
}

const IDENTITY_PRIORITY = ['email', 'phone'];

export function primaryIdentity(identities: CustomerIdentity[]): { type: string; value: string } | null {
  const sorted = [...identities].sort((a, b) => rank(a.type) - rank(b.type));
  const first = sorted[0];
  return first ? { type: first.type, value: first.value } : null;
}

function rank(type: string): number {
  const index = IDENTITY_PRIORITY.indexOf(type);
  return index === -1 ? IDENTITY_PRIORITY.length : index;
}
