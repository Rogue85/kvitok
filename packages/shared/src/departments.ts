import { z } from 'zod';
import { patchOf } from './patch.js';
import { FieldKeySchema } from './fields.js';

const DepartmentBase = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().max(4000).default(''),
  examples: z.array(z.string().trim().min(1).max(2000)).max(20).default([]),
  instructions: z.string().max(20_000).default(''),
  isTriage: z.boolean().default(false),
});

export const CreateDepartmentSchema = DepartmentBase.extend({ key: FieldKeySchema });
export type CreateDepartmentInput = z.input<typeof CreateDepartmentSchema>;

export const UpdateDepartmentSchema = patchOf(DepartmentBase).extend({ archived: z.boolean().optional() });
export type UpdateDepartmentInput = z.input<typeof UpdateDepartmentSchema>;

export interface DepartmentDto {
  id: string;
  key: string;
  title: string;
  description: string;
  examples: string[];
  instructions: string;
  isTriage: boolean;
  archived: boolean;
}
