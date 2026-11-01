import type { WorkspaceRole } from '@kvitok/shared';

/**
 * The departments a member may see: null — every department, including tickets without one.
 * Access is per workspace for now, so it is always null; department membership will narrow it for operators and viewers.
 * Notifications intersect it with the departments the member chose.
 */
export function accessibleDepartments(_member: { userId: string; role: WorkspaceRole }): ReadonlySet<string> | null {
  return null;
}
