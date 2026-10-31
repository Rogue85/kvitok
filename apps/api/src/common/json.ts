import type { Prisma } from '../generated/prisma/client';

/** Typed objects (interfaces) → a Prisma Json field. */
export function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}
