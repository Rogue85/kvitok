import { canSeeDepartment } from '@kvitok/shared';
import { memberScope } from '../departments/department-access';
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
