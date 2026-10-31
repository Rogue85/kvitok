import { z } from 'zod';

type PatchShape<T extends z.ZodRawShape> = { [K in keyof T]: z.ZodOptional<T[K] extends z.ZodDefault<infer Inner> ? Inner : T[K]> };

/**
 * A PATCH schema from a create schema: all fields are optional and have no defaults.
 * `.partial()` in zod 4 keeps `.default()`, so a partial update overwrote omitted fields with defaults.
 */
export function patchOf<T extends z.ZodRawShape>(schema: z.ZodObject<T>): z.ZodObject<PatchShape<T>> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    const inner = field instanceof z.ZodDefault ? (field.unwrap() as z.ZodType) : (field as z.ZodType);
    shape[key] = inner.optional();
  }
  return z.object(shape) as unknown as z.ZodObject<PatchShape<T>>;
}
