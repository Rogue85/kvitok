import { roleSatisfies, type WorkspaceRole } from '@kvitok/shared';

/** The current workspace from the `/w/:workspaceId/...` route and the user's role in it. */
export function useWorkspace() {
  const route = useRoute();
  const { me } = useAuth();

  const workspaceId = computed(() => String(route.params.workspaceId ?? ''));
  const membership = computed(() => me.value?.memberships.find((m) => m.workspaceId === workspaceId.value) ?? null);
  const role = computed<WorkspaceRole | null>(() => (me.value?.user.isSuperadmin ? 'admin' : (membership.value?.role ?? null)));

  function can(required: WorkspaceRole): boolean {
    return role.value !== null && roleSatisfies(role.value, required);
  }

  return { workspaceId, membership, role, can };
}
