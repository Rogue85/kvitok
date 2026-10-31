import type { ChannelDto, DepartmentDto, FieldDefinitionDto, MemberDto } from '@kvitok/shared';

/** Workspace reference data for forms and labels: departments, members, fields, channels. */
export function useWorkspaceData() {
  const { workspaceId } = useWorkspace();
  const key = (name: string) => `${name}:${workspaceId.value}`;
  const options = { watch: [workspaceId], default: () => [] };

  const departments = useAsyncData(() => key('departments'), () => api<DepartmentDto[]>(`/workspaces/${workspaceId.value}/departments`), options);
  const members = useAsyncData(() => key('members'), () => api<MemberDto[]>(`/workspaces/${workspaceId.value}/members`), options);
  const fields = useAsyncData(() => key('fields'), () => api<FieldDefinitionDto[]>(`/workspaces/${workspaceId.value}/fields`), options);
  const channels = useAsyncData(() => key('channels'), () => api<ChannelDto[]>(`/workspaces/${workspaceId.value}/channels`), options);

  const departmentById = computed(() => new Map(departments.data.value.map((d) => [d.id, d])));
  const memberById = computed(() => new Map(members.data.value.map((m) => [m.userId, m])));
  const ticketFields = computed(() => fields.data.value.filter((f) => f.entity === 'ticket' && !f.archived));
  const customerFields = computed(() => fields.data.value.filter((f) => f.entity === 'customer' && !f.archived));

  return { departments, members, fields, channels, departmentById, memberById, ticketFields, customerFields };
}
