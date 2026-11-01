import { canSeeDepartment, type DepartmentDto } from '@kvitok/shared';
import { describe, expect, it } from 'vitest';
import { memberScope } from '../app/utils/departments';

const department = (id: string, isTriage = false): DepartmentDto =>
  ({ id, key: id, title: id, description: '', examples: [], instructions: '', isTriage, archived: false }) as DepartmentDto;
const departments = [department('a'), department('b'), department('t', true)];

describe('memberScope', () => {
  it('gives admins and members with every department everything', () => {
    expect(memberScope({ role: 'admin', departments: { allDepartments: false, departmentIds: ['a'] } }, departments)).toEqual({ all: true });
    expect(memberScope({ role: 'operator', departments: { allDepartments: true, departmentIds: [] } }, departments)).toEqual({ all: true });
  });

  it('restricts others to their list; the triage department brings tickets without a department', () => {
    const operator = memberScope({ role: 'operator', departments: { allDepartments: false, departmentIds: ['a'] } }, departments);
    expect(canSeeDepartment(operator, 'a')).toBe(true);
    expect(canSeeDepartment(operator, 'b')).toBe(false);
    expect(canSeeDepartment(operator, null)).toBe(false);
    const triage = memberScope({ role: 'viewer', departments: { allDepartments: false, departmentIds: ['t'] } }, departments);
    expect(canSeeDepartment(triage, null)).toBe(true);
  });
});
