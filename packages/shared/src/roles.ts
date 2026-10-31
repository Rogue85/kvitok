import { z } from 'zod';

export const WORKSPACE_ROLES = ['admin', 'operator', 'viewer'] as const;

export const WorkspaceRoleSchema = z.enum(WORKSPACE_ROLES);
export type WorkspaceRole = z.infer<typeof WorkspaceRoleSchema>;

const ROLE_RANK: Record<WorkspaceRole, number> = { viewer: 0, operator: 1, admin: 2 };

/** Role `actual` grants at least the rights of `required`. */
export function roleSatisfies(actual: WorkspaceRole, required: WorkspaceRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}
