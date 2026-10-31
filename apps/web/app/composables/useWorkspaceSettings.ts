import type { WorkspaceDto } from '@kvitok/shared';

/** The workspace itself: its name and the currency model prices and run costs are in. */
export function useWorkspaceSettings() {
  const { workspaceId } = useWorkspace();
  return useAsyncData(() => `workspace:${workspaceId.value}`, () => api<WorkspaceDto>(`/workspaces/${workspaceId.value}`), { watch: [workspaceId] });
}
