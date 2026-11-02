<script setup lang="ts">
import { canSeeDepartment, type MemberDto } from '@kvitok/shared';

/**
 * The ticket's assignees, several at once. Members of the ticket's department come first; the others are listed with
 * their departments, and either get access to this ticket when assigned (the workspace keeps assignees' access)
 * or cannot be chosen.
 */
const props = defineProps<{ departmentId: string | null; assigneeIds: string[]; keepAccess: boolean; disabled?: boolean }>();
/** Who to add and who to remove, not the whole list: a click before the last answer, or someone the distributor just added, is not lost. */
const emit = defineEmits<{ update: [change: { addAssigneeIds?: string[]; removeAssigneeIds?: string[] }] }>();

function change(next: string[]): void {
  const add = next.filter((id) => !props.assigneeIds.includes(id));
  const remove = props.assigneeIds.filter((id) => !next.includes(id));
  if (add.length === 0 && remove.length === 0) return;
  emit('update', { ...(add.length ? { addAssigneeIds: add } : {}), ...(remove.length ? { removeAssigneeIds: remove } : {}) });
}

const { departments, members, departmentById } = useWorkspaceData();

function sees(member: MemberDto): boolean {
  return canSeeDepartment(memberScope(member, departments.data.value), props.departmentId);
}

function departmentsText(member: MemberDto): string {
  if (member.role === 'admin' || member.departments.allDepartments) return t('members.allDepartments');
  const titles = member.departments.departmentIds.map((id) => departmentById.value.get(id)?.title).filter(Boolean);
  return titles.length > 0 ? titles.join(', ') : t('ticket.assignees.noDepartments');
}

function item(member: MemberDto, native: boolean) {
  const assigned = props.assigneeIds.includes(member.userId);
  const blocked = !native && !props.keepAccess && !assigned;
  const hint = native || assigned ? '' : ` · ${t(props.keepAccess ? 'ticket.assignees.getsAccess' : 'ticket.assignees.noAccess')}`;
  return {
    label: member.name,
    value: member.userId,
    description: `${departmentsText(member)}${hint}`,
    // A green dot: the member accepts tickets now.
    ...(member.acceptingTickets ? { chip: { color: 'success' as const } } : {}),
    disabled: blocked,
  };
}

/** Current assignees stay in the list whatever they became, so they can be removed. */
const items = computed(() => {
  const candidates = members.data.value.filter(
    (m) => props.assigneeIds.includes(m.userId) || (m.role !== 'viewer' && m.status !== 'disabled'),
  );
  const own = candidates.filter(sees);
  const others = candidates.filter((m) => !sees(m));
  const departmentTitle = props.departmentId ? (departmentById.value.get(props.departmentId)?.title ?? '') : t('tickets.filters.noDepartment');
  // Group headers carry a value too, so every item has the value key; they cannot be chosen.
  const header = (label: string) => ({ type: 'label' as const, label, value: `label:${label}` });
  return [
    ...(own.length > 0 ? [[header(departmentTitle), ...own.map((m) => item(m, true))]] : []),
    ...(others.length > 0 ? [[header(t('ticket.assignees.otherDepartments')), ...others.map((m) => item(m, false))]] : []),
  ];
});
</script>

<template>
  <USelectMenu
    :model-value="assigneeIds"
    :items="items"
    value-key="value"
    multiple
    :filter-fields="['label', 'description']"
    :placeholder="t('ticket.sidebar.unassigned')"
    :search-input="{ placeholder: t('common.search') }"
    :disabled="disabled"
    class="w-full"
    @update:model-value="change($event as string[])"
  />
</template>
