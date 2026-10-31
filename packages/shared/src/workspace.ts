import { t } from '@kvitok/i18n';
import { z } from 'zod';
import { EmailSchema, PasswordSchema } from './auth.js';
import { WorkspaceRoleSchema, type WorkspaceRole } from './roles.js';

export const SlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { error: () => t('validation.slug') });

export const CreateWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: SlugSchema,
});
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceSchema>;

export const UpdateWorkspaceSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    locale: z.string().trim().min(2).max(16),
  })
  .partial();
export type UpdateWorkspaceInput = z.infer<typeof UpdateWorkspaceSchema>;

/** Add a member: an existing user by email or a new one (then name and password are required). */
export const AddMemberSchema = z.object({
  email: EmailSchema,
  role: WorkspaceRoleSchema,
  name: z.string().trim().min(1).max(120).optional(),
  password: PasswordSchema.optional(),
});
export type AddMemberInput = z.infer<typeof AddMemberSchema>;

export const UpdateMemberSchema = z.object({
  role: WorkspaceRoleSchema,
});
export type UpdateMemberInput = z.infer<typeof UpdateMemberSchema>;

export interface WorkspaceDto {
  id: string;
  name: string;
  slug: string;
  locale: string;
  createdAt: string;
}

export interface MemberDto {
  userId: string;
  email: string;
  name: string;
  role: WorkspaceRole;
  createdAt: string;
}
