import { ALL_DEPARTMENTS, canSeeDepartment, roleSatisfies, type DepartmentScope, type WorkspaceRole } from '@kvitok/shared';

/** The current workspace from the `/w/:workspaceId/...` route, the user's role in it and the departments whose tickets they see. */
export function useWorkspace() {
  const route = useRoute();
  const { me } = useAuth();

  const workspaceId = computed(() => String(route.params.workspaceId ?? ''));
  const membership = computed(() => me.value?.workspaces.find((w) => w.workspaceId === workspaceId.value) ?? null);
  const role = computed<WorkspaceRole | null>(() => membership.value?.role ?? null);
  const scope = computed<DepartmentScope>(() => membership.value?.departments ?? ALL_DEPARTMENTS);

  function can(required: WorkspaceRole): boolean {
    return role.value !== null && roleSatisfies(role.value, required);
  }

  /** Whether the user sees tickets of this department (null — without one). */
  function canSee(departmentId: string | null): boolean {
    return canSeeDepartment(scope.value, departmentId);
  }

  return { workspaceId, membership, role, scope, can, canSee };
}
