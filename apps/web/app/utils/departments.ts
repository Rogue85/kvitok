import { ALL_DEPARTMENTS, type DepartmentDto, type DepartmentScope, type MemberDto } from '@kvitok/shared';

/** The departments a member sees, computed as the API does for its own user: admins and "all departments" see everything. */
export function memberScope(member: Pick<MemberDto, 'role' | 'departments'>, departments: DepartmentDto[]): DepartmentScope {
  if (member.role === 'admin' || member.departments.allDepartments) return ALL_DEPARTMENTS;
  const ids = member.departments.departmentIds;
  const triage = departments.find((d) => d.isTriage)?.id ?? null;
  return { all: false, departmentIds: ids, unrouted: triage !== null && ids.includes(triage) };
}
