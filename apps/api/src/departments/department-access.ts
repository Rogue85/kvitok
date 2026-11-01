import { ALL_DEPARTMENTS, type DepartmentScope, type WorkspaceRole } from '@kvitok/shared';
import type { Prisma } from '../generated/prisma/client';

/**
 * What services take instead of a bare workspace id when they read or change tickets: the workspace and
 * the departments the caller may see. `WorkspaceContext` from the guard is one; code with no user behind it uses `systemAccess`.
 */
export interface TicketAccess {
  workspaceId: string;
  scope: DepartmentScope;
}

/** For workers, ingest, the agent and other code that acts for the system: every ticket of the workspace. */
export function systemAccess(workspaceId: string): TicketAccess {
  return { workspaceId, scope: ALL_DEPARTMENTS };
}

/** What a membership query includes to compute the scope. */
export const MEMBERSHIP_DEPARTMENTS = { departments: { select: { departmentId: true } } } satisfies Prisma.MembershipInclude;

export interface MembershipAccess {
  role: WorkspaceRole;
  allDepartments: boolean;
  departments: Array<{ departmentId: string }>;
}

/**
 * The departments a member may see. Admins and members with every department see every ticket; a restricted member sees
 * their departments, and tickets without a department only as a member of the triage department.
 * Notifications intersect it with the departments the member chose.
 */
export function departmentScopeOf(membership: MembershipAccess, triageDepartmentId: string | null): DepartmentScope {
  if (membership.role === 'admin' || membership.allDepartments) {
    return ALL_DEPARTMENTS;
  }
  const departmentIds = membership.departments.map((d) => d.departmentId);
  return { all: false, departmentIds, unrouted: triageDepartmentId !== null && departmentIds.includes(triageDepartmentId) };
}

/** The workspace's triage department: it decides who sees tickets without a department. */
export async function triageDepartmentId(db: Pick<Prisma.TransactionClient, 'department'>, workspaceId: string): Promise<string | null> {
  const triage = await db.department.findFirst({ where: { workspaceId, isTriage: true }, select: { id: true } });
  return triage?.id ?? null;
}

/** The scope of a loaded membership; reads the triage department only for a restricted member. */
export async function membershipScope(
  db: Pick<Prisma.TransactionClient, 'department'>,
  workspaceId: string,
  membership: MembershipAccess,
): Promise<DepartmentScope> {
  if (membership.role === 'admin' || membership.allDepartments) {
    return ALL_DEPARTMENTS;
  }
  return departmentScopeOf(membership, await triageDepartmentId(db, workspaceId));
}

/** A ticket condition for the scope: nothing for every department; an empty list matches no ticket. */
export function ticketScopeWhere(scope: DepartmentScope): Prisma.TicketWhereInput {
  if (scope.all) {
    return {};
  }
  return { OR: [{ departmentId: { in: scope.departmentIds } }, ...(scope.unrouted ? [{ departmentId: null }] : [])] };
}

/**
 * The departments a member may see by user id; null when they are not a member. A superadmin sees everything.
 * Read anew on every call: access changes take effect at once.
 */
export async function memberScope(
  db: Pick<Prisma.TransactionClient, 'department' | 'membership'>,
  workspaceId: string,
  userId: string,
): Promise<DepartmentScope | null> {
  const membership = await db.membership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    include: { ...MEMBERSHIP_DEPARTMENTS, user: { select: { isSuperadmin: true } } },
  });
  if (membership === null) return null;
  return membership.user.isSuperadmin ? ALL_DEPARTMENTS : membershipScope(db, workspaceId, membership);
}
