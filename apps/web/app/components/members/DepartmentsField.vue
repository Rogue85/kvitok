<script setup lang="ts">
import type { DepartmentDto, MemberDepartmentsInput, TicketListDto } from '@kvitok/shared';

/**
 * Which departments a member sees: every one, or a chosen list. For an existing member it also tells how many of their
 * open tickets fall outside the new list: they keep them as an assignee while the workspace keeps assignees' access,
 * otherwise they are unassigned.
 */
const model = defineModel<MemberDepartmentsInput>({ required: true });
const props = defineProps<{
  departments: DepartmentDto[];
  workspaceId: string;
  member?: { userId: string; name: string };
}>();

const modeItems = [
  { label: t('members.allDepartments'), value: 'all' },
  { label: t('members.selectedDepartments'), value: 'selected' },
];
const mode = computed({
  get: () => (model.value.allDepartments ? 'all' : 'selected'),
  set: (value: string) => {
    model.value = { allDepartments: value === 'all', departmentIds: value === 'all' ? [] : model.value.departmentIds };
  },
});
const selected = computed({
  get: () => model.value.departmentIds,
  set: (departmentIds: string[]) => {
    model.value = { allDepartments: false, departmentIds };
  },
});

// Active departments first; archived ones keep their tickets, so access to them can still be given.
const items = computed(() =>
  [...props.departments]
    .sort((a, b) => Number(a.archived) - Number(b.archived))
    .map((d) => ({
      label: d.archived ? `${d.title} (${t('members.archived')})` : d.title,
      description: d.isTriage ? t('departments.triage') : undefined,
      value: d.id,
    })),
);
const triage = computed(() => props.departments.find((d) => d.isTriage) ?? null);

const { data: workspace } = useWorkspaceSettings();
const keepAccess = computed(() => workspace.value?.assignment.assigneesKeepAccess ?? false);

const OPEN = 'status=new,open,pending';
const unassigned = ref(0);

/** Open tickets of the member outside the chosen departments: the save unassigns them. */
async function countUnassigned(): Promise<void> {
  const member = props.member;
  if (!member || model.value.allDepartments) {
    unassigned.value = 0;
    return;
  }
  const ids = [...model.value.departmentIds, ...(triage.value && model.value.departmentIds.includes(triage.value.id) ? ['none'] : [])];
  // Kept as an assignee, closed tickets stay visible too, so they count; unassigned, only open tickets are touched.
  const status = keepAccess.value ? '' : `&${OPEN}`;
  const total = async (query: string) =>
    (await api<TicketListDto>(`/workspaces/${props.workspaceId}/tickets?assignee=${member.userId}${status}&pageSize=1${query}`)).total;
  try {
    const [all, kept] = await Promise.all([total(''), ids.length > 0 ? total(`&departmentId=${ids.join(',')}`) : Promise.resolve(0)]);
    unassigned.value = all - kept;
  } catch {
    unassigned.value = 0;
  }
}
watch([model, keepAccess], countUnassigned, { immediate: true, deep: true });
</script>

<template>
  <div class="space-y-3">
    <URadioGroup v-model="mode" :items="modeItems" />
    <template v-if="!model.allDepartments">
      <UCheckboxGroup v-model="selected" :items="items" />
      <UAlert v-if="selected.length === 0" color="warning" variant="subtle" :title="t('members.noDepartmentsWarning')" />
    </template>
    <UAlert
      v-if="member && unassigned > 0"
      variant="subtle"
      :color="keepAccess ? 'info' : 'warning'"
      :title="tp(keepAccess ? 'members.keepAssignedInfo' : 'members.unassignWarning', unassigned, { name: member.name })"
    />
    <p class="text-sm text-(--ui-text-muted)">
      {{ t('members.departmentsHint') }}
      <template v-if="triage">{{ t('members.unroutedHint') }}</template>
    </p>
  </div>
</template>
