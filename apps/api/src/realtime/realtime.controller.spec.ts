import type { DepartmentScope } from '@kvitok/shared';
import { describe, expect, it } from 'vitest';
import { deliverable } from './realtime.controller';

const restricted: DepartmentScope = { all: false, departmentIds: ['a'], unrouted: false };
const access = { scope: restricted, assignedTo: null };
const guest = { scope: restricted, assignedTo: 'u' };

describe('deliverable', () => {
  it('passes ticket events of the departments the connection sees', () => {
    const event = { type: 'ticket.updated' as const, ticketId: 't' };
    expect(deliverable({ event, departmentId: 'a', assigneeIds: [] }, access, 'u')).toBe(true);
    expect(deliverable({ event, departmentId: 'b', assigneeIds: [] }, access, 'u')).toBe(false);
    expect(deliverable({ event, departmentId: null, assigneeIds: [] }, access, 'u')).toBe(false);
    expect(deliverable({ event, departmentId: null, assigneeIds: [] }, { scope: { ...restricted, unrouted: true }, assignedTo: null }, 'u')).toBe(true);
  });

  it('passes events of tickets the connection sees as an assignee, only while assignees keep access', () => {
    const event = { type: 'ticket.updated' as const, ticketId: 't' };
    expect(deliverable({ event, departmentId: 'b', assigneeIds: ['u'] }, guest, 'u')).toBe(true);
    expect(deliverable({ event, departmentId: 'b', assigneeIds: ['v'] }, guest, 'u')).toBe(false);
    expect(deliverable({ event, departmentId: 'b', assigneeIds: ['u'] }, access, 'u')).toBe(false);
  });

  it('sends a ticket whose department is unknown only to those who see every department', () => {
    const event = { type: 'message.created' as const, ticketId: 't', messageId: 'm' };
    expect(deliverable({ event, departmentId: undefined, assigneeIds: [] }, access, 'u')).toBe(false);
    expect(deliverable({ event, departmentId: undefined, assigneeIds: [] }, { scope: { all: true }, assignedTo: null }, 'u')).toBe(true);
  });

  it('sends a move to both departments and its assignees, an access change to its user only', () => {
    const all = { scope: { all: true as const }, assignedTo: null };
    expect(deliverable({ event: { type: 'ticket.moved', ticketId: 't', from: 'b', to: 'a' }, departmentId: undefined, assigneeIds: [] }, access, 'u')).toBe(true);
    expect(deliverable({ event: { type: 'ticket.moved', ticketId: 't', from: 'a', to: 'b' }, departmentId: undefined, assigneeIds: [] }, access, 'u')).toBe(true);
    expect(deliverable({ event: { type: 'ticket.moved', ticketId: 't', from: 'b', to: null }, departmentId: undefined, assigneeIds: [] }, access, 'u')).toBe(false);
    expect(deliverable({ event: { type: 'ticket.moved', ticketId: 't', from: 'b', to: 'c' }, departmentId: undefined, assigneeIds: ['u'] }, guest, 'u')).toBe(true);
    expect(deliverable({ event: { type: 'access.changed', userId: 'u' }, departmentId: undefined, assigneeIds: [] }, all, 'u')).toBe(true);
    expect(deliverable({ event: { type: 'access.changed', userId: 'v' }, departmentId: undefined, assigneeIds: [] }, all, 'u')).toBe(false);
  });

  it('sends a change of assignees to the users added and removed', () => {
    const event = { type: 'ticket.access' as const, ticketId: 't', userIds: ['u', 'w'] };
    expect(deliverable({ event, departmentId: undefined, assigneeIds: [] }, access, 'u')).toBe(true);
    expect(deliverable({ event, departmentId: undefined, assigneeIds: [] }, { scope: { all: true }, assignedTo: null }, 'v')).toBe(false);
  });
});
