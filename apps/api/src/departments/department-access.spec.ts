import { canSeeDepartment, type DepartmentScope } from '@kvitok/shared';
import { describe, expect, it } from 'vitest';
import { canSeeTicket, departmentScopeOf, ticketScopeWhere } from './department-access';

const member = (role: 'admin' | 'operator' | 'viewer', allDepartments: boolean, ids: string[] = []) => ({
  role,
  allDepartments,
  departments: ids.map((departmentId) => ({ departmentId })),
});

describe('departmentScopeOf', () => {
  it('gives admins and members with every department every ticket', () => {
    expect(departmentScopeOf(member('admin', false, ['a']), null)).toEqual({ all: true });
    expect(departmentScopeOf(member('operator', true), 't')).toEqual({ all: true });
    expect(departmentScopeOf(member('viewer', true), null)).toEqual({ all: true });
  });

  it('restricts operators and viewers to their departments', () => {
    expect(departmentScopeOf(member('operator', false, ['a', 'b']), 't')).toEqual({ all: false, departmentIds: ['a', 'b'], unrouted: false });
    expect(departmentScopeOf(member('viewer', false, ['b']), null)).toEqual({ all: false, departmentIds: ['b'], unrouted: false });
  });

  it('shows tickets without a department to members of the triage department', () => {
    expect(departmentScopeOf(member('operator', false, ['a', 't']), 't')).toMatchObject({ unrouted: true });
    expect(departmentScopeOf(member('operator', false, ['a']), 't')).toMatchObject({ unrouted: false });
  });

  it('sees nothing with an empty list', () => {
    const scope = departmentScopeOf(member('operator', false), 't');
    expect(canSeeDepartment(scope, 'a')).toBe(false);
    expect(canSeeDepartment(scope, null)).toBe(false);
  });
});

describe('canSeeDepartment', () => {
  const scope: DepartmentScope = { all: false, departmentIds: ['a'], unrouted: false };

  it('checks the department and tickets without one', () => {
    expect(canSeeDepartment({ all: true }, 'x')).toBe(true);
    expect(canSeeDepartment({ all: true }, null)).toBe(true);
    expect(canSeeDepartment(scope, 'a')).toBe(true);
    expect(canSeeDepartment(scope, 'b')).toBe(false);
    expect(canSeeDepartment(scope, null)).toBe(false);
    expect(canSeeDepartment({ ...scope, unrouted: true }, null)).toBe(true);
  });
});

describe('ticketScopeWhere', () => {
  it('adds nothing for every department', () => {
    expect(ticketScopeWhere({ workspaceId: 'w', scope: { all: true }, assignedTo: 'u' })).toEqual({});
  });

  it('matches the departments and, when allowed, tickets without one', () => {
    expect(ticketScopeWhere({ workspaceId: 'w', scope: { all: false, departmentIds: ['a'], unrouted: false }, assignedTo: null })).toEqual({ OR: [{ departmentId: { in: ['a'] } }] });
    expect(ticketScopeWhere({ workspaceId: 'w', scope: { all: false, departmentIds: [], unrouted: true }, assignedTo: null })).toEqual({
      OR: [{ departmentId: { in: [] } }, { departmentId: null }],
    });
  });

  it('adds the tickets assigned to the caller when the workspace keeps their access', () => {
    expect(ticketScopeWhere({ workspaceId: 'w', scope: { all: false, departmentIds: ['a'], unrouted: false }, assignedTo: 'u' })).toEqual({
      OR: [{ departmentId: { in: ['a'] } }, { assignees: { some: { workspaceId: 'w', userId: 'u' } } }],
    });
  });
});

describe('canSeeTicket', () => {
  const scope: DepartmentScope = { all: false, departmentIds: ['a'], unrouted: false };

  it('sees the departments, and assigned tickets only through assignedTo', () => {
    expect(canSeeTicket({ scope, assignedTo: null }, { departmentId: 'a', assigneeIds: [] })).toBe(true);
    expect(canSeeTicket({ scope, assignedTo: null }, { departmentId: 'b', assigneeIds: ['u'] })).toBe(false);
    expect(canSeeTicket({ scope, assignedTo: 'u' }, { departmentId: 'b', assigneeIds: ['u'] })).toBe(true);
    expect(canSeeTicket({ scope, assignedTo: 'u' }, { departmentId: 'b', assigneeIds: ['v'] })).toBe(false);
  });
});
