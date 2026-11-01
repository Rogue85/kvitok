<script setup lang="ts">
import type { MessageKey } from '@kvitok/i18n';
import { TICKET_PRIORITIES, type DepartmentDto, type NotificationSettings, type WorkspaceRole } from '@kvitok/shared';

const props = defineProps<{ workspaceId: string; role: WorkspaceRole }>();
const toast = useToast();

const { data: loaded, error } = await useAsyncData(`notification-settings:${props.workspaceId}`, () =>
  api<NotificationSettings>(`/workspaces/${props.workspaceId}/notification-settings`),
);
const { data: departments } = await useAsyncData(`departments:${props.workspaceId}`, () => api<DepartmentDto[]>(`/workspaces/${props.workspaceId}/departments`), {
  default: () => [],
});

const form = ref<NotificationSettings | null>(null);
watch(loaded, (value) => (form.value = value ? structuredClone(toRaw(value)) : null), { immediate: true });
const dirty = computed(() => form.value !== null && JSON.stringify(form.value) !== JSON.stringify(loaded.value));

const scopeItems = (values: string[], labels: Record<string, MessageKey> = {}) =>
  values.map((value) => ({ value, label: t(labels[value] ?? (`notifications.scope.${value}` as MessageKey)) }));
const ticketScopes = scopeItems(['off', 'mine', 'mine_unassigned', 'all']);
const createdScopes = scopeItems(['off', 'mine_unassigned', 'all'], { mine_unassigned: 'notifications.scope.unassigned', all: 'notifications.scope.allTickets' });
const deliveryScopes = scopeItems(['off', 'mine', 'all'], { mine: 'notifications.scope.myReplies', all: 'notifications.scope.allReplies' });
const toggleItems = [
  { value: 'on', label: t('notifications.scope.on') },
  { value: 'off', label: t('notifications.scope.off') },
];
const priorityItems = TICKET_PRIORITIES.map((value) => ({ value, label: t(`ticketPriority.${value}`) }));

const departmentItems = computed(() =>
  departments.value.filter((d) => !d.archived || form.value?.departmentIds?.includes(d.id)).map((d) => ({ value: d.id, label: d.title })),
);
const allDepartments = computed({
  get: () => form.value?.departmentIds === null,
  set: (all: boolean) => {
    if (form.value) form.value.departmentIds = all ? null : departments.value.filter((d) => !d.archived).map((d) => d.id);
  },
});

/** A boolean event shown as a select, so every row looks and works the same. */
function toggle(key: 'assigned' | 'agentFailed') {
  return computed({
    get: () => (form.value?.events[key] ? 'on' : 'off'),
    set: (value: string) => {
      if (form.value) form.value.events[key] = value === 'on';
    },
  });
}
const assigned = toggle('assigned');
const agentFailed = toggle('agentFailed');

const saving = ref(false);
async function save(): Promise<void> {
  if (!form.value) return;
  saving.value = true;
  try {
    loaded.value = await api<NotificationSettings>(`/workspaces/${props.workspaceId}/notification-settings`, { method: 'PUT', body: form.value });
    toast.add({ title: t('notifications.saved'), icon: 'i-lucide-check' });
  } catch (e) {
    toast.add({ color: 'error', title: e instanceof ApiError ? e.message : t('notifications.saveFailed') });
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UAlert v-if="error" color="neutral" variant="subtle" icon="i-lucide-info" :title="error instanceof ApiError ? error.message : t('notifications.notMember')" />
  <form v-else-if="form" class="space-y-6" @submit.prevent="save">
    <div class="divide-y divide-(--ui-border)">
      <div class="flex flex-wrap items-center justify-between gap-2 py-3">
        <span class="text-sm">{{ t('notifications.events.ticketCreated') }}</span>
        <USelect v-model="form.events.ticketCreated" :items="createdScopes" class="w-64" />
      </div>
      <div class="flex flex-wrap items-center justify-between gap-2 py-3">
        <span class="text-sm">{{ t('notifications.events.assigned') }}</span>
        <USelect v-model="assigned" :items="toggleItems" class="w-64" />
      </div>
      <div class="flex flex-wrap items-center justify-between gap-2 py-3">
        <span class="text-sm">{{ t('notifications.events.customerMessage') }}</span>
        <USelect v-model="form.events.customerMessage" :items="ticketScopes" class="w-64" />
      </div>
      <div class="flex flex-wrap items-center justify-between gap-2 py-3">
        <div>
          <p class="text-sm">{{ t('notifications.events.agentNeedsOperator') }}</p>
          <p class="text-xs text-(--ui-text-muted)">{{ t('notifications.events.agentNeedsOperatorHint') }}</p>
        </div>
        <USelect v-model="form.events.agentNeedsOperator" :items="ticketScopes" class="w-64" />
      </div>
      <div class="flex flex-wrap items-center justify-between gap-2 py-3">
        <span class="text-sm">{{ t('notifications.events.deliveryFailed') }}</span>
        <USelect v-model="form.events.deliveryFailed" :items="deliveryScopes" class="w-64" />
      </div>
      <div v-if="role === 'admin'" class="flex flex-wrap items-center justify-between gap-2 py-3">
        <div>
          <p class="text-sm">{{ t('notifications.events.agentFailed') }}</p>
          <p class="text-xs text-(--ui-text-muted)">{{ t('notifications.events.agentFailedHint') }}</p>
        </div>
        <USelect v-model="agentFailed" :items="toggleItems" class="w-64" />
      </div>
    </div>
    <p class="text-sm text-(--ui-text-muted)">{{ t('notifications.waitHint') }}</p>

    <section class="space-y-3">
      <div>
        <h3 class="font-semibold">{{ t('notifications.filters') }}</h3>
        <p class="text-sm text-(--ui-text-muted)">{{ t('notifications.filtersHint') }}</p>
      </div>
      <UFormField :label="t('notifications.departments')">
        <div class="space-y-2">
          <UCheckbox v-model="allDepartments" :label="t('notifications.allDepartments')" />
          <template v-if="form.departmentIds !== null">
            <USelectMenu v-model="form.departmentIds" :items="departmentItems" value-key="value" multiple class="w-full max-w-md" />
            <UCheckbox v-model="form.noDepartment" :label="t('notifications.noDepartment')" />
          </template>
        </div>
      </UFormField>
      <UFormField :label="t('notifications.minPriority')">
        <USelect v-model="form.minPriority" :items="priorityItems" class="w-64" />
      </UFormField>
    </section>

    <UButton type="submit" :loading="saving" :disabled="!dirty">{{ t('common.save') }}</UButton>
  </form>
</template>
