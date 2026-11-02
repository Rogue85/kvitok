import type { Prisma } from '../generated/prisma/client';
import { triageDepartmentId } from '../departments/department-access';
import { OPEN_TICKET_STATUSES } from './assignment';
import { recordEvent, type Actor } from './ticket-events';

/**
 * Records a ticket's move to another department; `data` goes into the event. The caller writes the department and then
 * runs `settleAssignees`, once after all the changes of the operation (a rule stage, an agent result, an operator's edit).
 */
export async function recordDepartmentChange(
  tx: Prisma.TransactionClient,
  ticket: { id: string; workspaceId: string; departmentId: string | null },
  to: string | null,
  actor: Actor,
  data: Record<string, unknown> = {},
): Promise<void> {
  await recordEvent(tx, { workspaceId: ticket.workspaceId, ticketId: ticket.id, actor, type: 'department_changed', data: { from: ticket.departmentId, to, ...data } });
}

/** What a change of the triage department affects: tickets without a department to settle, and the members whose access to them changed. */
export interface TriageChange {
  /** Open tickets without a department that have assignees; settled after the change commits (`settleEach`). */
  tickets: string[];
  members: string[];
}

/**
 * Follows up a change that may have moved the triage flag: the triage department decides who sees tickets without
 * a department. Returns their open tickets with assignees, to be settled as after a department change, and the restricted
 * members of the old and the new triage department, so their open pages and streams reload access. `before` — the triage
 * department before the change.
 */
export async function applyTriageChange(tx: Prisma.TransactionClient, workspaceId: string, before: string | null): Promise<TriageChange> {
  const after = await triageDepartmentId(tx, workspaceId);
  if (after === before) {
    return { tickets: [], members: [] };
  }
  const tickets = await tx.ticket.findMany({
    where: { workspaceId, departmentId: null, assignees: { some: {} }, status: { in: [...OPEN_TICKET_STATUSES] } },
    select: { id: true },
  });
  // Administrators always have every department, so they are never among the restricted members.
  const members = await tx.membershipDepartment.findMany({
    where: { workspaceId, departmentId: { in: [before, after].filter((id): id is string => id !== null) }, membership: { allDepartments: false } },
    select: { userId: true },
    distinct: ['userId'],
  });
  return { tickets: tickets.map((t) => t.id), members: members.map((m) => m.userId) };
}
