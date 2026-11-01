import { canSeeDepartment, type DepartmentScope } from '@kvitok/shared';
import { memberScope, triageDepartmentId } from '../departments/department-access';
import type { Prisma } from '../generated/prisma/client';
import { recordEvent, type Actor } from './ticket-events';

/**
 * Records a ticket's move to another department and keeps its assignee able to see it: an assignee without access
 * to the new department is unassigned. The caller writes the department, and `assigneeId: null` when `unassign`.
 * `data` goes into both events.
 */
export async function recordDepartmentChange(
  tx: Prisma.TransactionClient,
  ticket: { id: string; workspaceId: string; departmentId: string | null; assigneeId: string | null },
  to: string | null,
  actor: Actor,
  data: Record<string, unknown> = {},
): Promise<{ unassign: boolean }> {
  const base = { workspaceId: ticket.workspaceId, ticketId: ticket.id, actor };
  await recordEvent(tx, { ...base, type: 'department_changed', data: { from: ticket.departmentId, to, ...data } });
  if (ticket.assigneeId === null) {
    return { unassign: false };
  }
  const scope = await memberScope(tx, ticket.workspaceId, ticket.assigneeId);
  if (scope !== null && canSeeDepartment(scope, to)) {
    return { unassign: false };
  }
  await recordEvent(tx, {
    ...base,
    type: 'assignee_changed',
    data: { from: ticket.assigneeId, to: null, reason: 'department_access', departmentId: to, ...data },
  });
  return { unassign: true };
}

/** What a change of the triage department changed: unassigned tickets and the members whose access to tickets without a department changed. */
export interface TriageChange {
  unassigned: string[];
  members: string[];
}

/**
 * Follows up a change that may have moved the triage flag: the triage department decides who sees tickets without
 * a department. Their assignees who no longer see them are unassigned, and the restricted members of the old and the
 * new triage department are returned, so their open pages and streams reload access. `before` — the triage department
 * before the change.
 */
export async function applyTriageChange(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  before: string | null,
  actor: Actor,
): Promise<TriageChange> {
  const after = await triageDepartmentId(tx, workspaceId);
  if (after === before) {
    return { unassigned: [], members: [] };
  }
  const tickets = await tx.ticket.findMany({
    where: { workspaceId, departmentId: null, assigneeId: { not: null }, status: { notIn: ['resolved', 'closed'] } },
    select: { id: true, assigneeId: true },
  });
  const scopes = new Map<string, DepartmentScope | null>();
  const unassigned: string[] = [];
  for (const ticket of tickets) {
    const assigneeId = ticket.assigneeId!;
    if (!scopes.has(assigneeId)) scopes.set(assigneeId, await memberScope(tx, workspaceId, assigneeId));
    const scope = scopes.get(assigneeId)!;
    if (scope !== null && canSeeDepartment(scope, null)) continue;
    await tx.ticket.update({ where: { id: ticket.id }, data: { assigneeId: null } });
    await recordEvent(tx, {
      workspaceId,
      ticketId: ticket.id,
      type: 'assignee_changed',
      actor,
      data: { from: assigneeId, to: null, reason: 'triage_changed' },
    });
    unassigned.push(ticket.id);
  }
  // Administrators always have every department, so they are never among the restricted members.
  const members = await tx.membershipDepartment.findMany({
    where: { workspaceId, departmentId: { in: [before, after].filter((id): id is string => id !== null) }, membership: { allDepartments: false } },
    select: { userId: true },
    distinct: ['userId'],
  });
  return { unassigned, members: members.map((m) => m.userId) };
}
