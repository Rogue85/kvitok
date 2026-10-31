<script setup lang="ts">
import {
  TICKET_PRIORITIES,
  type CustomerLinkDto,
  type FieldDefinitionDto,
  type TicketDto,
  type TicketPriority,
  type UpdateTicketInput,
} from '@kvitok/shared';

const props = defineProps<{ ticket: TicketDto; links: CustomerLinkDto[] }>();
const emit = defineEmits<{ update: [patch: UpdateTicketInput]; changed: [] }>();

const { can } = useWorkspace();
const { departments, members, ticketFields, customerFields } = useWorkspaceData();
const editable = computed(() => can('operator'));

const priorityItems = TICKET_PRIORITIES.map((value) => ({ label: priorityLabel(value), value }));
const departmentItems = computed(() => [
  { label: t('tickets.filters.noDepartment'), value: 'none' },
  ...departments.data.value.filter((d) => !d.archived || d.id === props.ticket.departmentId).map((d) => ({ label: d.title, value: d.id })),
]);
const assigneeItems = computed(() => [
  { label: t('ticket.sidebar.unassigned'), value: 'none' },
  ...members.data.value.filter((m) => m.role !== 'viewer').map((m) => ({ label: m.name, value: m.userId })),
]);

const visibleFields = computed(() =>
  ticketFields.value.filter(
    (f) =>
      f.display.includes('sidebar') &&
      (f.scopeDepartmentIds.length === 0 || (props.ticket.departmentId !== null && f.scopeDepartmentIds.includes(props.ticket.departmentId))),
  ),
);

const draft = ref<Record<string, unknown>>({});
watch(
  () => props.ticket.fields,
  (fields) => {
    draft.value = { ...fields };
  },
  { immediate: true, deep: true },
);
const changedKeys = computed(() =>
  visibleFields.value.map((f) => f.key).filter((key) => JSON.stringify(draft.value[key] ?? null) !== JSON.stringify(props.ticket.fields[key] ?? null)),
);
function saveFields(): void {
  emit('update', { fields: Object.fromEntries(changedKeys.value.map((key) => [key, draft.value[key] ?? null])) });
}

const tags = ref<string[]>([]);
watch(() => props.ticket.tags, (value) => (tags.value = [...value]), { immediate: true });
function saveTags(): void {
  if (JSON.stringify(tags.value) !== JSON.stringify(props.ticket.tags)) emit('update', { tags: tags.value });
}

function requiredMark(field: FieldDefinitionDto): string {
  return field.requiredOn.includes('resolve') ? ' *' : '';
}
</script>

<template>
  <div class="space-y-6">
    <section class="space-y-3">
      <h3 class="text-xs font-semibold uppercase text-(--ui-text-muted)">{{ t('ticket.sidebar.properties') }}</h3>
      <UFormField :label="t('ticket.sidebar.priority')" size="sm">
        <USelect
          :model-value="ticket.priority"
          :items="priorityItems"
          :disabled="!editable"
          class="w-full"
          @update:model-value="emit('update', { priority: $event as TicketPriority })"
        />
      </UFormField>
      <UFormField :label="t('ticket.sidebar.department')" size="sm" :hint="ticket.departmentLocked ? t('ticket.sidebar.pinned') : undefined">
        <USelect
          :model-value="ticket.departmentId ?? 'none'"
          :items="departmentItems"
          :disabled="!editable"
          class="w-full"
          @update:model-value="emit('update', { departmentId: $event === 'none' ? null : String($event) })"
        />
      </UFormField>
      <UFormField :label="t('ticket.sidebar.assignee')" size="sm">
        <USelect
          :model-value="ticket.assignee?.id ?? 'none'"
          :items="assigneeItems"
          :disabled="!editable"
          class="w-full"
          @update:model-value="emit('update', { assigneeId: $event === 'none' ? null : String($event) })"
        />
      </UFormField>
      <UFormField :label="t('ticket.sidebar.tags')" size="sm">
        <UInputTags v-model="tags" :disabled="!editable" class="w-full" @blur="saveTags" @update:model-value="saveTags" />
      </UFormField>
    </section>

    <section v-if="visibleFields.length" class="space-y-3">
      <h3 class="text-xs font-semibold uppercase text-(--ui-text-muted)">{{ t('ticket.sidebar.fields') }}</h3>
      <UFormField v-for="field in visibleFields" :key="field.key" size="sm" :description="field.agentHint ? undefined : undefined">
        <template #label>
          <span class="inline-flex items-center gap-1">{{ field.label }}{{ requiredMark(field) }} <FieldsFieldMetaBadge :meta="ticket.fieldMeta[field.key]" /></span>
        </template>
        <FieldsFieldInput v-model="draft[field.key]" :field="field" :disabled="!editable" />
      </UFormField>
      <UButton v-if="changedKeys.length" size="sm" block icon="i-lucide-save" @click="saveFields">{{ t('ticket.sidebar.saveFields') }}</UButton>
    </section>

    <section class="space-y-2">
      <h3 class="text-xs font-semibold uppercase text-(--ui-text-muted)">{{ t('ticket.sidebar.customer') }}</h3>
      <template v-if="ticket.customer">
        <p class="font-medium">{{ ticket.customer.name ?? t('ticket.sidebar.noName') }}</p>
        <dl class="space-y-1 text-sm">
          <div v-for="identity in ticket.customer.identities" :key="`${identity.type}:${identity.value}`" class="flex gap-2">
            <dt class="w-24 shrink-0 text-(--ui-text-muted)">{{ identity.type }}</dt>
            <dd class="truncate">{{ identity.value }}</dd>
          </div>
          <div v-for="field in customerFields" :key="field.key" class="flex gap-2">
            <dt class="w-24 shrink-0 text-(--ui-text-muted)">{{ field.label }}</dt>
            <dd class="truncate">{{ formatFieldValue(ticket.customer.fields[field.key], field.options) }}</dd>
          </div>
        </dl>
        <TicketCustomerLinks :ticket="ticket" :links="links" @changed="emit('changed')" />
      </template>
      <p v-else class="text-sm text-(--ui-text-muted)">{{ t('ticket.sidebar.noCustomer') }}</p>
    </section>

    <section v-if="ticket.participants.length" class="space-y-2">
      <h3 class="text-xs font-semibold uppercase text-(--ui-text-muted)">{{ t('ticket.sidebar.participants') }}</h3>
      <ul class="space-y-1 text-sm">
        <li v-for="p in ticket.participants" :key="p.email" class="flex items-center gap-2">
          <UIcon :name="p.role === 'customer' ? 'i-lucide-user' : 'i-lucide-users'" class="text-(--ui-text-muted)" />
          <span class="truncate">{{ p.name ? `${p.name} <${p.email}>` : p.email }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>
