import { TICKET_PRIORITIES, type DepartmentScope, type NotificationSettings, type TicketPriority, type WorkspaceRole } from '@kvitok/shared';
import { canSeeTicket } from '../departments/department-access';

export type NotificationKind = 'ticket_created' | 'assigned' | 'customer_message' | 'agent_needs_operator' | 'delivery_failed' | 'agent_failed';

export interface Recipient {
  userId: string;
  role: WorkspaceRole;
  settings: NotificationSettings;
  /** The departments the member may see (`departmentScopeOf`). */
  departments: DepartmentScope;
  /** The member sees tickets assigned to them whatever their department (the workspace keeps assignees' access). */
  seesAssigned: boolean;
}

export interface TicketFacts {
  departmentId: string | null;
  assigneeIds: string[];
  priority: TicketPriority;
  /** The operator who wrote the undelivered reply (`delivery_failed`). */
  authorId?: string | null;
}

/**
 * Whether the member gets the event about the ticket. Tickets assigned to the member always pass the filters;
 * the others pass when the department and the priority match. A ticket the member cannot see never does.
 */
export function wants(recipient: Recipient, kind: NotificationKind, ticket: TicketFacts): boolean {
  const { settings, userId } = recipient;
  if (!canSeeTicket({ scope: recipient.departments, assignedTo: recipient.seesAssigned ? userId : null }, ticket)) {
    return false;
  }
  const mine = ticket.assigneeIds.includes(userId);
  const unassigned = ticket.assigneeIds.length === 0;
  const filtered = passesFilters(settings, ticket);

  switch (kind) {
    case 'assigned':
      return settings.events.assigned && mine;
    case 'ticket_created': {
      // A ticket assigned on arrival goes to its assignee as `assigned`, unless they turned that off and follow every new ticket.
      if (mine) return !settings.events.assigned && settings.events.ticketCreated === 'all' && filtered;
      const scope = settings.events.ticketCreated;
      return scope === 'all' ? filtered : scope === 'mine_unassigned' && unassigned && filtered;
    }
    case 'customer_message':
    case 'agent_needs_operator': {
      const scope = kind === 'customer_message' ? settings.events.customerMessage : settings.events.agentNeedsOperator;
      if (scope === 'off') return false;
      if (mine) return true;
      return scope === 'all' ? filtered : scope === 'mine_unassigned' && unassigned && filtered;
    }
    case 'delivery_failed': {
      const scope = settings.events.deliveryFailed;
      if (scope === 'off') return false;
      return ticket.authorId === userId || (scope === 'all' && (mine || filtered));
    }
    case 'agent_failed':
      return recipient.role === 'admin' && settings.events.agentFailed && (mine || filtered);
  }
}

function passesFilters(settings: NotificationSettings, ticket: TicketFacts): boolean {
  if (TICKET_PRIORITIES.indexOf(ticket.priority) < TICKET_PRIORITIES.indexOf(settings.minPriority)) return false;
  if (settings.departmentIds === null) return true;
  return ticket.departmentId === null ? settings.noDepartment : settings.departmentIds.includes(ticket.departmentId);
}
