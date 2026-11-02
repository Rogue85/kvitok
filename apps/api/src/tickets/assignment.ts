import {
  ALL_DEPARTMENTS,
  assignmentSettings,
  canSeeDepartment,
  MAX_TICKET_ASSIGNEES,
  type AssigneeSource,
  type AssignmentSettings,
  type DepartmentScope,
} from '@kvitok/shared';
import { departmentScopeOf, MEMBERSHIP_DEPARTMENTS, triageDepartmentId } from '../departments/department-access';
import type { Prisma, PrismaClient, TicketAssignee } from '../generated/prisma/client';
import type { NotificationsService } from '../notifications/notifications.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { recordEvent, SYSTEM_ACTOR, type Actor } from './ticket-events';

/** Tickets the distributor hands out and whose assignees are kept consistent: not resolved or closed. */
export const OPEN_TICKET_STATUSES = ['new', 'open', 'pending'] as const;

/** A status change that brings a resolved or closed ticket back to work. */
export function reopens(from: string, to: string | undefined): boolean {
  return to !== undefined && !(OPEN_TICKET_STATUSES as readonly string[]).includes(from) && (OPEN_TICKET_STATUSES as readonly string[]).includes(to);
}

/** Why the assignees are settled: the reason of removals in the `assignees_changed` event. */
export type RemovalReason = 'department_changed' | 'access_removed' | 'triage_changed' | 'reopened';

/** Who was added to and removed from one ticket's assignees: their access to it changed, and the added get notified. */
export interface AssigneeChange {
  ticketId: string;
  added: string[];
  removed: string[];
}

export function changedUsers(change: AssigneeChange): string[] {
  return [...change.added, ...change.removed];
}

/** Changes of one operation, one entry per ticket: an assignee added and removed in it is neither. */
export function mergeChanges(changes: AssigneeChange[]): AssigneeChange[] {
  const byTicket = new Map<string, AssigneeChange>();
  for (const change of changes) {
    const merged = byTicket.get(change.ticketId) ?? { ticketId: change.ticketId, added: [], removed: [] };
    for (const id of change.removed) {
      if (merged.added.includes(id)) merged.added = merged.added.filter((a) => a !== id);
      else if (!merged.removed.includes(id)) merged.removed.push(id);
    }
    for (const id of change.added) {
      if (merged.removed.includes(id)) merged.removed = merged.removed.filter((r) => r !== id);
      else if (!merged.added.includes(id)) merged.added.push(id);
    }
    byTicket.set(change.ticketId, merged);
  }
  return [...byTicket.values()];
}

/**
 * After the transaction: the users added and removed reload their access to the tickets, and the added ones are notified
 * (never the actor, who did it themselves).
 */
export async function publishAssigneeChanges(
  realtime: RealtimeService,
  notifications: NotificationsService,
  workspaceId: string,
  changes: AssigneeChange[],
  actorId: string | null,
): Promise<void> {
  for (const ticket of mergeChanges(changes)) {
    const users = changedUsers(ticket);
    if (users.length > 0) {
      await realtime.publish(workspaceId, { type: 'ticket.access', ticketId: ticket.ticketId, userIds: users });
    }
    const notify = ticket.added.filter((u) => u !== actorId);
    if (notify.length > 0) {
      await notifications.assigned(workspaceId, ticket.ticketId, actorId, notify);
    }
  }
}

export async function workspaceAssignment(db: Pick<Prisma.TransactionClient, 'workspace'>, workspaceId: string): Promise<AssignmentSettings> {
  const workspace = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { settings: true } });
  return assignmentSettings(workspace.settings);
}

/** A member's own access, ignoring the tickets assigned to them: their departments, and whether they can work on tickets at all. */
export interface MemberAccessFacts {
  scope: DepartmentScope;
  /** An operator or admin who is not disabled. */
  canWork: boolean;
}

/** Access of each user; null for a user who is not a member of the workspace. A superadmin sees every department. */
export async function memberAccessFacts(
  db: Pick<Prisma.TransactionClient, 'membership' | 'department'>,
  workspaceId: string,
  userIds: readonly string[],
): Promise<Map<string, MemberAccessFacts | null>> {
  const facts = new Map<string, MemberAccessFacts | null>(userIds.map((id) => [id, null]));
  if (userIds.length === 0) return facts;
  const [memberships, triageId] = await Promise.all([
    db.membership.findMany({
      where: { workspaceId, userId: { in: [...userIds] } },
      include: { ...MEMBERSHIP_DEPARTMENTS, user: { select: { isSuperadmin: true, disabledAt: true } } },
    }),
    triageDepartmentId(db, workspaceId),
  ]);
  for (const membership of memberships) {
    facts.set(membership.userId, {
      scope: membership.user.isSuperadmin ? ALL_DEPARTMENTS : departmentScopeOf(membership, triageId),
      canWork: membership.role !== 'viewer' && membership.user.disabledAt === null,
    });
  }
  return facts;
}

/** The departments each user sees through their own access; null for a user who is not a member. */
export async function departmentScopes(
  db: Pick<Prisma.TransactionClient, 'membership' | 'department'>,
  workspaceId: string,
  userIds: readonly string[],
): Promise<Map<string, DepartmentScope | null>> {
  const facts = await memberAccessFacts(db, workspaceId, userIds);
  return new Map([...facts].map(([id, f]) => [id, f?.scope ?? null]));
}

/** An assignee "of the department": works on tickets and sees the department through their own access, not as a guest. */
function isNative(facts: MemberAccessFacts | null | undefined, departmentId: string | null): boolean {
  return facts !== null && facts !== undefined && facts.canWork && canSeeDepartment(facts.scope, departmentId);
}

/**
 * Locks the ticket row for a change of its assignees, so concurrent changes do not both pass the checks. Taken before
 * the department row the distributor locks: every path locks the ticket first, as the agent does.
 */
export async function lockTicketForAssignees(tx: Prisma.TransactionClient, ticketId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${ticketId} FOR NO KEY UPDATE`;
}

/** Records one change of a ticket's assignees in its timeline. */
export async function recordAssigneesChange(
  tx: Prisma.TransactionClient,
  ticket: { id: string; workspaceId: string },
  actor: Actor,
  change: { added?: string[]; removed?: string[]; source?: AssigneeSource; reason?: string; departmentId?: string | null },
): Promise<void> {
  await recordEvent(tx, {
    workspaceId: ticket.workspaceId,
    ticketId: ticket.id,
    type: 'assignees_changed',
    actor,
    data: { added: change.added ?? [], removed: change.removed ?? [], ...withoutUndefined({ source: change.source, reason: change.reason, departmentId: change.departmentId }) },
  });
}

/** Adds assignees the caller has already checked; those already on the ticket are skipped. Returns the added ones. */
export async function addAssignees(
  tx: Prisma.TransactionClient,
  ticket: { id: string; workspaceId: string },
  userIds: readonly string[],
  source: AssigneeSource,
  actor: Actor,
  extra: { reason?: string; departmentId?: string | null; actedAt?: Date } = {},
): Promise<string[]> {
  const requested = [...new Set(userIds)];
  if (requested.length === 0) return [];
  // Only the rows actually inserted count: one already there is not added again.
  const inserted = await tx.ticketAssignee.createManyAndReturn({
    data: requested.map((userId) => ({
      ticketId: ticket.id,
      userId,
      workspaceId: ticket.workspaceId,
      source,
      addedById: actor.type === 'user' ? (actor.id ?? null) : null,
      actedAt: extra.actedAt ?? null,
    })),
    skipDuplicates: true,
    select: { userId: true },
  });
  const added = requested.filter((id) => inserted.some((row) => row.userId === id));
  if (added.length === 0) return [];
  await recordAssigneesChange(tx, ticket, actor, { added, source, reason: extra.reason, departmentId: extra.departmentId });
  return added;
}

export async function removeAssignees(
  tx: Prisma.TransactionClient,
  ticket: { id: string; workspaceId: string },
  userIds: readonly string[],
  actor: Actor,
  extra: { reason?: string; departmentId?: string | null } = {},
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const { count } = await tx.ticketAssignee.deleteMany({ where: { ticketId: ticket.id, userId: { in: [...userIds] } } });
  if (count === 0) return [];
  await recordAssigneesChange(tx, ticket, actor, { removed: [...userIds], ...extra });
  return [...userIds];
}

/** At most `MAX_TICKET_ASSIGNEES`: true when the list fits. */
export function fitsAssigneeLimit(userIds: readonly string[]): boolean {
  return new Set(userIds).size <= MAX_TICKET_ASSIGNEES;
}

/**
 * Keeps a ticket's assignees consistent with its department after the department, its status or someone's access changed:
 * assignees of other departments are removed (when the workspace does not keep their access, or when the distributor gave
 * them the ticket and they never worked on it); then, if no assignee of the department is left, the department's distributor
 * adds one. An assignee of the department is an operator or admin, not disabled, who sees it through their own access.
 * Only open tickets are handed out.
 */
export async function settleAssignees(tx: Prisma.TransactionClient, ticketId: string, actor: Actor, reason: RemovalReason): Promise<AssigneeChange> {
  await lockTicketForAssignees(tx, ticketId);
  const ticket = await tx.ticket.findUniqueOrThrow({
    where: { id: ticketId },
    select: { id: true, workspaceId: true, departmentId: true, status: true, assignees: true },
  });
  const change: AssigneeChange = { ticketId, added: [], removed: [] };
  const settings = await workspaceAssignment(tx, ticket.workspaceId);
  const facts = await memberAccessFacts(tx, ticket.workspaceId, ticket.assignees.map((a) => a.userId));
  const native = (a: TicketAssignee) => isNative(facts.get(a.userId), ticket.departmentId);
  // Not a member any more: removing a member clears their assignments, so such a row is history only.
  const removable = ticket.assignees.filter(
    (a) => !native(a) && facts.get(a.userId) !== null && (!settings.assigneesKeepAccess || (a.source === 'auto' && a.actedAt === null)),
  );
  change.removed = await removeAssignees(tx, ticket, removable.map((a) => a.userId), actor, { reason, departmentId: ticket.departmentId });

  const remaining = ticket.assignees.filter((a) => !change.removed.includes(a.userId));
  const handOut =
    ticket.departmentId !== null &&
    (OPEN_TICKET_STATUSES as readonly string[]).includes(ticket.status) &&
    !remaining.some(native) &&
    remaining.length < MAX_TICKET_ASSIGNEES;
  if (handOut) {
    const next = await nextAssignee(tx, ticket.workspaceId, ticket.departmentId!, new Set(remaining.map((a) => a.userId)));
    if (next !== null) {
      change.added = await addAssignees(tx, ticket, [next], 'auto', SYSTEM_ACTOR, { reason: 'auto', departmentId: ticket.departmentId });
    }
  }
  return change;
}

/**
 * Settles many tickets after a change that affects them all (a setting, a member's access, the triage department),
 * each in its own short transaction once that change is committed: one long transaction would hold department rows
 * while waiting for tickets the agent has locked, and the other way round.
 */
export async function settleEach(prisma: PrismaClient, ticketIds: readonly string[], actor: Actor, reason: RemovalReason): Promise<AssigneeChange[]> {
  const changes: AssigneeChange[] = [];
  for (const ticketId of ticketIds) {
    const change = await prisma.$transaction((tx) => settleAssignees(tx, ticketId, actor, reason));
    if (change.added.length > 0 || change.removed.length > 0) changes.push(change);
  }
  return changes;
}

/**
 * The member who gets the department's next ticket, or null: the department hands tickets out by hand, or nobody can take one.
 * Round robin over operators and admins who accept tickets, are not disabled and see the department through their own access,
 * ordered by user id after the last one who got a ticket. The department row is locked, so concurrent tickets go to different people;
 * NO KEY UPDATE, because a ticket moved into the department in the same transaction already holds KEY SHARE on it through
 * the foreign key, and FOR UPDATE would deadlock two such transactions.
 */
async function nextAssignee(tx: Prisma.TransactionClient, workspaceId: string, departmentId: string, exclude: Set<string>): Promise<string | null> {
  const [department] = await tx.$queryRaw<Array<{ assignment_mode: string; last_assigned_user_id: string | null }>>`
    SELECT assignment_mode::text AS assignment_mode, last_assigned_user_id FROM departments
    WHERE id = ${departmentId} AND workspace_id = ${workspaceId} AND archived_at IS NULL FOR NO KEY UPDATE`;
  if (department === undefined || department.assignment_mode !== 'round_robin') {
    return null;
  }
  const [members, triageId] = await Promise.all([
    tx.membership.findMany({
      where: { workspaceId, acceptingTickets: true, role: { in: ['admin', 'operator'] }, user: { disabledAt: null } },
      include: { ...MEMBERSHIP_DEPARTMENTS, user: { select: { isSuperadmin: true } } },
      orderBy: { userId: 'asc' },
    }),
    triageDepartmentId(tx, workspaceId),
  ]);
  const candidates = members
    .filter((m) => !exclude.has(m.userId) && (m.user.isSuperadmin || canSeeDepartment(departmentScopeOf(m, triageId), departmentId)))
    .map((m) => m.userId);
  const cursor = department.last_assigned_user_id;
  const next = (cursor === null ? undefined : candidates.find((id) => id > cursor)) ?? candidates[0];
  if (next === undefined) {
    return null;
  }
  await tx.department.update({ where: { id: departmentId }, data: { lastAssignedUserId: next } });
  return next;
}

/**
 * The operator worked on the ticket actively: replied to the customer, wrote to the agent, decided on an action.
 * An assignee gets the time of it; anyone else becomes an assignee while the workspace assigns active operators.
 * A user who is not a member (a superadmin looking around) is never added.
 */
export async function markActive(tx: Prisma.TransactionClient, workspaceId: string, ticketId: string, userId: string): Promise<AssigneeChange> {
  const change: AssigneeChange = { ticketId, added: [], removed: [] };
  const now = new Date();
  await lockTicketForAssignees(tx, ticketId);
  const { count } = await tx.ticketAssignee.updateMany({ where: { ticketId, userId }, data: { actedAt: now } });
  if (count > 0 || !(await workspaceAssignment(tx, workspaceId)).assignActiveOperator) {
    return change;
  }
  const membership = await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } }, select: { role: true } });
  if (membership === null || membership.role === 'viewer') {
    return change;
  }
  if ((await tx.ticketAssignee.count({ where: { ticketId } })) >= MAX_TICKET_ASSIGNEES) {
    return change;
  }
  change.added = await addAssignees(tx, { id: ticketId, workspaceId }, [userId], 'action', { type: 'user', id: userId }, { reason: 'active', actedAt: now });
  return change;
}

/**
 * A person of the ticket's department has taken it, and the agent stops moving it to another department (it only suggests):
 * an assignee of the department who was assigned by hand or by a rule, or who worked on the ticket. A distributor's untouched
 * pick, a guest of another department, or anyone while the ticket is in the triage department or has none, does not count:
 * telling the agent where a ticket belongs is what triage is for.
 */
export async function takenByHuman(tx: Prisma.TransactionClient, ticket: { id: string; workspaceId: string; departmentId: string | null }): Promise<boolean> {
  if (ticket.departmentId === null || ticket.departmentId === (await triageDepartmentId(tx, ticket.workspaceId))) {
    return false;
  }
  const taken = (await tx.ticketAssignee.findMany({ where: { ticketId: ticket.id }, select: { userId: true, source: true, actedAt: true } })).filter(
    (a) => a.source !== 'auto' || a.actedAt !== null,
  );
  const facts = await memberAccessFacts(tx, ticket.workspaceId, taken.map((a) => a.userId));
  return taken.some((a) => isNative(facts.get(a.userId), ticket.departmentId));
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
