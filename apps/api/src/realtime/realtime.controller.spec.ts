import type { DepartmentScope } from '@kvitok/shared';
import { describe, expect, it } from 'vitest';
import { deliverable } from './realtime.controller';

const restricted: DepartmentScope = { all: false, departmentIds: ['a'], unrouted: false };

describe('deliverable', () => {
  it('passes ticket events of the departments the connection sees', () => {
    const event = { type: 'ticket.updated' as const, ticketId: 't' };
    expect(deliverable({ event, departmentId: 'a' }, restricted, 'u')).toBe(true);
    expect(deliverable({ event, departmentId: 'b' }, restricted, 'u')).toBe(false);
    expect(deliverable({ event, departmentId: null }, restricted, 'u')).toBe(false);
    expect(deliverable({ event, departmentId: null }, { ...restricted, unrouted: true }, 'u')).toBe(true);
  });

  it('sends a ticket whose department is unknown only to those who see every department', () => {
    const event = { type: 'message.created' as const, ticketId: 't', messageId: 'm' };
    expect(deliverable({ event, departmentId: undefined }, restricted, 'u')).toBe(false);
    expect(deliverable({ event, departmentId: undefined }, { all: true }, 'u')).toBe(true);
  });

  it('sends a move to both departments and an access change to its user only', () => {
    expect(deliverable({ event: { type: 'ticket.moved', ticketId: 't', from: 'b', to: 'a' }, departmentId: undefined }, restricted, 'u')).toBe(true);
    expect(deliverable({ event: { type: 'ticket.moved', ticketId: 't', from: 'a', to: 'b' }, departmentId: undefined }, restricted, 'u')).toBe(true);
    expect(deliverable({ event: { type: 'ticket.moved', ticketId: 't', from: 'b', to: null }, departmentId: undefined }, restricted, 'u')).toBe(false);
    expect(deliverable({ event: { type: 'access.changed', userId: 'u' }, departmentId: undefined }, { all: true }, 'u')).toBe(true);
    expect(deliverable({ event: { type: 'access.changed', userId: 'v' }, departmentId: undefined }, { all: true }, 'u')).toBe(false);
  });
});
