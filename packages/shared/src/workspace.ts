import { t } from '@kvitok/i18n';
import { z } from 'zod';
import { EmailSchema } from './auth.js';
import { MemberDepartmentsSchema, type MemberDepartmentsInput } from './department-access.js';
import { WorkspaceRoleSchema, type WorkspaceRole } from './roles.js';

export const SlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { error: () => t('validation.slug') });

/** An ISO 4217 code: model prices and run costs of the workspace are in it. */
export const CurrencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, { error: () => t('validation.currency') })
  .refine((code) => Intl.supportedValuesOf('currency').includes(code), { error: () => t('validation.currency') });

export const CreateWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: SlugSchema,
  currency: CurrencySchema.optional(),
});
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceSchema>;

/** How tickets get assignees in the workspace. Stored in `workspaces.settings.assignment`; missing keys take the defaults. */
export const AssignmentSettingsSchema = z.object({
  /** An operator who replies, writes to the agent or decides on an action becomes an assignee. */
  assignActiveOperator: z.boolean().default(true),
  /** An assignee keeps seeing the ticket when it moves to a department they cannot see, and members of other departments can be assigned. */
  assigneesKeepAccess: z.boolean().default(true),
});
export type AssignmentSettings = z.output<typeof AssignmentSettingsSchema>;

/** Stored assignment settings with the defaults filled in; broken ones fall back to the defaults. */
export function assignmentSettings(stored: unknown): AssignmentSettings {
  const value = typeof stored === 'object' && stored !== null ? (stored as { assignment?: unknown }).assignment : undefined;
  const parsed = AssignmentSettingsSchema.safeParse(typeof value === 'object' && value !== null ? value : {});
  return parsed.success ? parsed.data : AssignmentSettingsSchema.parse({});
}

export const UpdateWorkspaceSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    locale: z.string().trim().min(2).max(16),
    currency: CurrencySchema,
    assignment: z.object({ assignActiveOperator: z.boolean(), assigneesKeepAccess: z.boolean() }).partial(),
  })
  .partial();
export type UpdateWorkspaceInput = z.infer<typeof UpdateWorkspaceSchema>;

export const UserNameSchema = z.string().trim().min(1).max(120);

/** Add a member: an existing user of the installation, or invite a new person by email. Without `departments` — every department. */
export const AddMemberSchema = z.union([
  z.object({ userId: z.string().min(1), role: WorkspaceRoleSchema, departments: MemberDepartmentsSchema.optional() }),
  z.object({ email: EmailSchema, name: UserNameSchema, role: WorkspaceRoleSchema, departments: MemberDepartmentsSchema.optional() }),
]);
export type AddMemberInput = z.infer<typeof AddMemberSchema>;

/** Only what changes; `departments` replaces the member's departments. */
export const UpdateMemberSchema = z.object({
  role: WorkspaceRoleSchema.optional(),
  departments: MemberDepartmentsSchema.optional(),
});
export type UpdateMemberInput = z.infer<typeof UpdateMemberSchema>;

/** The member's "accepting tickets" switch: members switch their own, admins anyone's. */
export const SetAcceptingTicketsSchema = z.object({ accepting: z.boolean() });
export type SetAcceptingTicketsInput = z.infer<typeof SetAcceptingTicketsSchema>;

export interface WorkspaceDto {
  id: string;
  name: string;
  slug: string;
  locale: string;
  currency: string;
  assignment: AssignmentSettings;
  createdAt: string;
}

/** active — can sign in; invited — has not set a password yet; disabled — cannot sign in. */
export type UserStatus = 'active' | 'invited' | 'disabled';

export interface MemberDto {
  userId: string;
  email: string;
  name: string;
  role: WorkspaceRole;
  departments: MemberDepartmentsInput;
  status: UserStatus;
  /** Takes tickets that departments hand out in turn. */
  acceptingTickets: boolean;
  createdAt: string;
}

/** A one-time link to set a password. The token is shown once; the web builds `/invite/<token>` from it. */
export interface PasswordLinkDto {
  token: string;
  purpose: 'invite' | 'reset';
  expiresAt: string;
}

export interface AddMemberResult {
  member: MemberDto;
  /** For a newly invited person. */
  link: PasswordLinkDto | null;
}

/** A user of the installation who can be given access to the workspace. */
export interface MemberCandidateDto {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
}

/**
 * A slug from a name: Cyrillic is transliterated, everything else that is not a letter or a digit becomes a hyphen.
 * Returns an empty string when nothing is left.
 */
export function slugify(name: string): string {
  return [...name.toLowerCase()]
    .map((char) => CYRILLIC[char] ?? char)
    .join('')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
}

const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'u',
};
