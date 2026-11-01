import { z } from 'zod';
import type { DepartmentScope } from './department-access.js';
import { WorkspaceRoleSchema } from './roles.js';

export const EmailSchema = z.string().trim().toLowerCase().pipe(z.email());

export const PasswordSchema = z.string().min(8).max(200);

export const LoginSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  isSuperadmin: boolean;
}

export interface MeResponse {
  user: AuthUser;
  /** Workspaces the user can open: their memberships, and every workspace for a superadmin. */
  workspaces: Array<{
    workspaceId: string;
    workspaceName: string;
    workspaceSlug: string;
    role: z.infer<typeof WorkspaceRoleSchema>;
    /** False when a superadmin opens a workspace without being its member. */
    isMember: boolean;
    /** Tickets of which departments the user may see. */
    departments: DepartmentScope;
  }>;
}
