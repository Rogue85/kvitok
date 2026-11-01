import { t } from '@kvitok/i18n';
import { z } from 'zod';
import { EmailSchema, PasswordSchema } from './auth.js';
import { MemberDepartmentsSchema, type MemberDepartmentsInput } from './department-access.js';
import { WorkspaceRoleSchema, type WorkspaceRole } from './roles.js';
import { CurrencySchema, UserNameSchema, type UserStatus } from './workspace.js';

/** Whether the installation still needs its first superadmin. */
export interface SetupStatusDto {
  required: boolean;
}

/** The first run: the first superadmin and the first workspace. */
export const SetupSchema = z.object({
  name: UserNameSchema,
  email: EmailSchema,
  password: PasswordSchema,
  workspaceName: z.string().trim().min(1).max(120),
  currency: CurrencySchema,
});
export type SetupInput = z.infer<typeof SetupSchema>;

/** What a password link is for, shown before the password is set. */
export interface PasswordLinkInfoDto {
  email: string;
  name: string;
  purpose: 'invite' | 'reset';
}

export const AcceptPasswordLinkSchema = z.object({
  password: PasswordSchema,
});
export type AcceptPasswordLinkInput = z.infer<typeof AcceptPasswordLinkSchema>;

export interface AdminUserDto {
  id: string;
  email: string;
  name: string;
  isSuperadmin: boolean;
  status: UserStatus;
  lastSeenAt: string | null;
  createdAt: string;
  memberships: Array<{ workspaceId: string; workspaceName: string; role: WorkspaceRole; departments: MemberDepartmentsInput }>;
}

export const CreateUserSchema = z.object({
  email: EmailSchema,
  name: UserNameSchema,
  isSuperadmin: z.boolean().default(false),
  memberships: z
    .array(z.object({ workspaceId: z.string().min(1), role: WorkspaceRoleSchema, departments: MemberDepartmentsSchema.optional() }))
    .max(100)
    .refine((list) => new Set(list.map((m) => m.workspaceId)).size === list.length, { error: () => t('validation.duplicateWorkspace') })
    .default([]),
});
export type CreateUserInput = z.infer<typeof CreateUserSchema>;

export const UpdateUserSchema = z
  .object({
    name: UserNameSchema,
    isSuperadmin: z.boolean(),
    disabled: z.boolean(),
  })
  .partial();
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;

/** Without `departments` a new membership gets every department and an existing one keeps its departments. */
export const SetMembershipSchema = z.object({
  role: WorkspaceRoleSchema,
  departments: MemberDepartmentsSchema.optional(),
});
export type SetMembershipInput = z.infer<typeof SetMembershipSchema>;

export const UpdateProfileSchema = z.object({
  name: UserNameSchema,
});
export type UpdateProfileInput = z.infer<typeof UpdateProfileSchema>;

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: PasswordSchema,
});
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;

export interface SessionDto {
  id: string;
  userAgent: string | null;
  ip: string | null;
  lastSeenAt: string;
  createdAt: string;
  current: boolean;
}
