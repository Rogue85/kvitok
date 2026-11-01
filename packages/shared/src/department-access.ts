import { t } from '@kvitok/i18n';
import { z } from 'zod';

/**
 * Which tickets a member may see in one workspace, by the ticket's current department.
 * `unrouted` — also tickets without a department. An empty list sees no department at all, never every one.
 */
export type DepartmentScope = { all: true } | { all: false; departmentIds: string[]; unrouted: boolean };

export const ALL_DEPARTMENTS: DepartmentScope = { all: true };

/** Whether a ticket in this department (null — without one) is visible in the scope. */
export function canSeeDepartment(scope: DepartmentScope, departmentId: string | null): boolean {
  if (scope.all) return true;
  return departmentId === null ? scope.unrouted : scope.departmentIds.includes(departmentId);
}

/** A member's departments as admins set them: every department, or a list. Administrators always have every one. */
export const MemberDepartmentsSchema = z
  .object({
    allDepartments: z.boolean(),
    departmentIds: z.array(z.string().min(1)).max(500),
  })
  .refine((value) => !value.allDepartments || value.departmentIds.length === 0, {
    error: () => t('validation.allDepartmentsWithList'),
    path: ['departmentIds'],
  });
export type MemberDepartmentsInput = z.infer<typeof MemberDepartmentsSchema>;
