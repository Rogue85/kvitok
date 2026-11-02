import { ALL_DEPARTMENTS, notificationSettings, type NotificationSettingsInput } from '@kvitok/shared';
import { describe, expect, it } from 'vitest';
import { pickKind } from './notification-dispatcher';
import { wants, type Recipient, type TicketFacts } from './notification-rules';

const ME = 'u1';

function recipient(settings: Partial<NotificationSettingsInput> = {}, extra: Partial<Recipient> = {}): Recipient {
  return { userId: ME, role: 'operator', settings: notificationSettings(settings), departments: ALL_DEPARTMENTS, seesAssigned: true, ...extra };
}

const unassigned: TicketFacts = { departmentId: 'd1', assigneeIds: [], priority: 'normal' };
const mine: TicketFacts = { ...unassigned, assigneeIds: ['u2', ME] };
const others: TicketFacts = { ...unassigned, assigneeIds: ['u2'] };

describe('notificationSettings', () => {
  it('fills in the defaults and survives broken data', () => {
    expect(notificationSettings(null).events).toEqual({
      ticketCreated: 'mine_unassigned',
      assigned: true,
      customerMessage: 'mine',
      agentNeedsOperator: 'mine_unassigned',
      deliveryFailed: 'mine',
      agentFailed: false,
    });
    expect(notificationSettings({ events: { customerMessage: 'all' } }).events.customerMessage).toBe('all');
    expect(notificationSettings({ events: { customerMessage: 'everything' } }).events.customerMessage).toBe('mine');
  });
});

describe('wants', () => {
  it('sends a new ticket to everyone following unassigned tickets, not to its assignee', () => {
    expect(wants(recipient(), 'ticket_created', unassigned)).toBe(true);
    expect(wants(recipient(), 'ticket_created', others)).toBe(false);
    expect(wants(recipient({ events: { ticketCreated: 'all' } }), 'ticket_created', others)).toBe(true);
    expect(wants(recipient({ events: { ticketCreated: 'all' } }), 'ticket_created', mine)).toBe(false);
    expect(wants(recipient({ events: { ticketCreated: 'off' } }), 'ticket_created', unassigned)).toBe(false);
  });

  it('follows the scope of customer messages', () => {
    expect(wants(recipient(), 'customer_message', mine)).toBe(true);
    expect(wants(recipient(), 'customer_message', unassigned)).toBe(false);
    expect(wants(recipient({ events: { customerMessage: 'mine_unassigned' } }), 'customer_message', unassigned)).toBe(true);
    expect(wants(recipient({ events: { customerMessage: 'mine_unassigned' } }), 'customer_message', others)).toBe(false);
    expect(wants(recipient({ events: { customerMessage: 'all' } }), 'customer_message', others)).toBe(true);
    expect(wants(recipient({ events: { customerMessage: 'off' } }), 'customer_message', mine)).toBe(false);
  });

  it('applies department and priority filters only to tickets of others', () => {
    const filtered = recipient({ events: { customerMessage: 'all' }, departmentIds: ['d2'], minPriority: 'high' });
    expect(wants(filtered, 'customer_message', others)).toBe(false);
    expect(wants(filtered, 'customer_message', { ...others, departmentId: 'd2' })).toBe(false);
    expect(wants(filtered, 'customer_message', { ...others, departmentId: 'd2', priority: 'urgent' })).toBe(true);
    expect(wants(filtered, 'customer_message', mine)).toBe(true);
  });

  it('lets tickets without a department through by choice', () => {
    const none = { ...unassigned, departmentId: null };
    expect(wants(recipient({ departmentIds: ['d1'] }), 'ticket_created', none)).toBe(true);
    expect(wants(recipient({ departmentIds: ['d1'], noDepartment: false }), 'ticket_created', none)).toBe(false);
  });

  it('never notifies about a department the member cannot see, unless the ticket is theirs and the workspace keeps their access', () => {
    const departments = { all: false as const, departmentIds: ['d2'], unrouted: false };
    const restricted = recipient({ events: { customerMessage: 'all' } }, { departments, seesAssigned: false });
    expect(wants(restricted, 'customer_message', others)).toBe(false);
    expect(wants(restricted, 'customer_message', mine)).toBe(false);
    expect(wants(restricted, 'customer_message', { ...others, departmentId: 'd2' })).toBe(true);
    const guest = recipient({ events: { customerMessage: 'all' } }, { departments });
    expect(wants(guest, 'customer_message', mine)).toBe(true);
    expect(wants(guest, 'customer_message', others)).toBe(false);
  });

  it('notifies about tickets without a department only those who may see them', () => {
    const none = { ...others, departmentId: null };
    const settings = { events: { customerMessage: 'all' as const } };
    expect(wants(recipient(settings, { departments: { all: false, departmentIds: ['d2'], unrouted: false } }), 'customer_message', none)).toBe(false);
    expect(wants(recipient(settings, { departments: { all: false, departmentIds: ['d2'], unrouted: true } }), 'customer_message', none)).toBe(true);
  });

  it('notifies about undelivered replies of the member', () => {
    expect(wants(recipient(), 'delivery_failed', { ...others, authorId: ME })).toBe(true);
    expect(wants(recipient(), 'delivery_failed', { ...mine, authorId: 'u2' })).toBe(false);
    expect(wants(recipient({ events: { deliveryFailed: 'all' } }), 'delivery_failed', { ...others, authorId: 'u2' })).toBe(true);
  });

  it('sends agent failures only to admins who asked for them', () => {
    expect(wants(recipient({ events: { agentFailed: true } }), 'agent_failed', others)).toBe(false);
    expect(wants(recipient({ events: { agentFailed: true } }, { role: 'admin' }), 'agent_failed', others)).toBe(true);
    expect(wants(recipient({}, { role: 'admin' }), 'agent_failed', others)).toBe(false);
  });
});

describe('pickKind', () => {
  const base = { workspaceId: 'w', ticketId: 't' };

  it('turns an incoming new ticket into assigned for its assignee', () => {
    expect(pickKind({ ...base, kind: 'incoming', created: true }, recipient(), mine)).toBe('assigned');
    expect(pickKind({ ...base, kind: 'incoming', created: true }, recipient(), unassigned)).toBe('ticket_created');
    expect(pickKind({ ...base, kind: 'incoming', created: false }, recipient(), mine)).toBe('customer_message');
  });

  it('tells an assignee who turned assignments off about a new ticket if they follow every new one', () => {
    const quiet = recipient({ events: { assigned: false, ticketCreated: 'all' } });
    expect(pickKind({ ...base, kind: 'incoming', created: true }, quiet, mine)).toBe('ticket_created');
    expect(pickKind({ ...base, kind: 'incoming', created: true }, recipient({ events: { assigned: false } }), mine)).toBeNull();
  });

  it('sends assigned only to the members just added', () => {
    expect(pickKind({ ...base, kind: 'assigned', userIds: [ME] }, recipient(), mine)).toBe('assigned');
    expect(pickKind({ ...base, kind: 'assigned', userIds: ['u2'] }, recipient(), mine)).toBeNull();
  });

  it('falls back to the agent needing an operator', () => {
    const quiet = recipient({ events: { ticketCreated: 'off' } });
    expect(pickKind({ ...base, kind: 'incoming', created: true }, quiet, unassigned)).toBeNull();
    expect(pickKind({ ...base, kind: 'incoming', created: true, needsOperator: true }, quiet, unassigned)).toBe('agent_needs_operator');
  });
});
