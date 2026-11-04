<script setup lang="ts">
import {
  AGENT_OPTIONS_LIST_LIMIT,
  FIELD_AGENT_OPTIONS_MODES,
  FIELD_DISPLAY,
  FIELD_FILL_MODES,
  FIELD_TYPES,
  type FieldAgentOptionsMode,
  type FieldDefinitionDto,
  type FieldEntity,
  type FieldFillMode,
  type FieldOption,
  type FieldType,
  type IntegrationDto,
} from '@kvitok/shared';
import type { TableColumn } from '@nuxt/ui';

const toast = useToast();
const { workspaceId, can } = useWorkspace();
const { fields, departments } = useWorkspaceData();
const isAdmin = computed(() => can('admin'));

const typeLabel = (type: FieldType) => t(`fieldsSettings.type.${type}`);
const fillLabel = (mode: FieldFillMode) => t(`fieldsSettings.fill.${mode}`);
const displayLabel = (display: (typeof FIELD_DISPLAY)[number]) => t(`fieldsSettings.display.${display}`);

// Directories the integrations publish: a list can take its options from one of them.
const { data: integrations } = await useAsyncData(
  () => `integrations:${workspaceId.value}`,
  () => api<IntegrationDto[]>(`/workspaces/${workspaceId.value}/integrations`),
  { default: () => [] },
);
const optionSets = computed(() => integrations.value.flatMap((i) => i.optionSets));
const optionSetItems = computed(() =>
  optionSets.value.map((s) => ({
    label: `${s.integrationName}: ${s.title}`,
    description: s.removed ? t('fieldsSettings.optionSetRemoved') : t('fieldsSettings.optionSetSize', { count: s.activeSize }),
    value: s.id,
  })),
);
const agentOptionsItems = FIELD_AGENT_OPTIONS_MODES.map((mode) => ({
  value: mode,
  label: t(`fieldsSettings.agentOptions.${mode}.label`),
  description: t(`fieldsSettings.agentOptions.${mode}.description`, { count: AGENT_OPTIONS_LIST_LIMIT }),
}));

const entity = ref<FieldEntity>('ticket');
const rows = computed(() => fields.data.value.filter((f) => f.entity === entity.value));
const columns: TableColumn<FieldDefinitionDto>[] = [
  { accessorKey: 'label', header: t('fieldsSettings.field') },
  { accessorKey: 'key', header: t('common.key') },
  { accessorKey: 'type', header: t('fieldsSettings.typeColumn') },
  { accessorKey: 'fillMode', header: t('fieldsSettings.fillColumn') },
  { id: 'flags', header: '' },
];

interface FieldForm {
  id: string | null;
  entity: FieldEntity;
  key: string;
  label: string;
  type: FieldType;
  options: FieldOption[];
  /** manual — the options below; set — a directory of an integration. */
  optionsSource: 'manual' | 'set';
  optionSetId: string | null;
  agentOptionsMode: FieldAgentOptionsMode;
  agentHint: string;
  fillMode: FieldFillMode;
  agentMinConfidence: number;
  requiredOnResolve: boolean;
  display: Array<(typeof FIELD_DISPLAY)[number]>;
  scopeDepartmentIds: string[];
  integer: boolean;
  min: number | null;
  max: number | null;
  pattern: string;
  archived: boolean;
}
const emptyForm = (): FieldForm => ({
  id: null, entity: entity.value, key: '', label: '', type: 'text', options: [], optionsSource: 'manual', optionSetId: null, agentOptionsMode: 'auto', agentHint: '', fillMode: 'manual',
  agentMinConfidence: 0.8, requiredOnResolve: false, display: ['sidebar'], scopeDepartmentIds: [],
  integer: false, min: null, max: null, pattern: '', archived: false,
});
const open = ref(false);
const form = reactive<FieldForm>(emptyForm());
const error = ref<string | null>(null);

function edit(field: FieldDefinitionDto | null): void {
  error.value = null;
  Object.assign(
    form,
    field
      ? {
          ...emptyForm(),
          ...field,
          // A bound field shows the set's options read-only; the form keeps only its own.
          options: field.optionSet ? [] : field.options.map((o) => ({ ...o })),
          optionsSource: field.optionSet ? 'set' : 'manual',
          optionSetId: field.optionSet?.id ?? null,
          requiredOnResolve: field.requiredOn.includes('resolve'),
          integer: field.validation.integer ?? false,
          min: field.validation.min ?? null,
          max: field.validation.max ?? null,
          pattern: field.validation.pattern ?? '',
        }
      : emptyForm(),
  );
  open.value = true;
}

const hasOptions = computed(() => form.type === 'select' || form.type === 'multiselect');
const optionSetModel = computed({
  get: () => form.optionSetId ?? undefined,
  set: (value: string | undefined) => {
    form.optionSetId = value ?? null;
  },
});
const fromSet = computed(() => hasOptions.value && form.optionsSource === 'set');
/** The options of the bound set, for a read-only preview. */
const editedField = computed(() => (form.id ? fields.data.value.find((f) => f.id === form.id) : undefined));
const setPreview = computed(() => (editedField.value?.optionSet?.id === form.optionSetId ? (editedField.value?.options ?? []) : []));
// Unbinding a field keeps the directory's options as its own: the manual list starts from them, archived ones included.
watch(
  () => form.optionsSource,
  (source) => {
    if (source === 'manual' && form.options.length === 0 && editedField.value?.optionSet) {
      form.options = editedField.value.options.map((o) => ({ ...o }));
    }
  },
);

async function save(): Promise<void> {
  error.value = null;
  const validation = {
    ...(form.type === 'number' && form.integer ? { integer: true } : {}),
    ...(form.type === 'number' && form.min !== null ? { min: form.min } : {}),
    ...(form.type === 'number' && form.max !== null ? { max: form.max } : {}),
    ...((form.type === 'text' || form.type === 'textarea') && form.pattern ? { pattern: form.pattern } : {}),
  };
  if (fromSet.value && !form.optionSetId) {
    error.value = t('fieldsSettings.optionSetRequired');
    return;
  }
  const body = {
    label: form.label,
    ...(fromSet.value ? { optionSetId: form.optionSetId } : { optionSetId: null, options: hasOptions.value ? form.options.filter((o) => o.value && o.label) : [] }),
    ...(hasOptions.value ? { agentOptionsMode: form.agentOptionsMode } : {}),
    validation,
    agentHint: form.agentHint,
    fillMode: form.fillMode,
    agentMinConfidence: form.agentMinConfidence,
    requiredOn: form.requiredOnResolve ? ['resolve'] : [],
    display: form.display,
    scopeDepartmentIds: form.scopeDepartmentIds,
  };
  try {
    if (form.id) {
      await api(`/workspaces/${workspaceId.value}/fields/${form.id}`, { method: 'PATCH', body: { ...body, archived: form.archived } });
    } else {
      await api(`/workspaces/${workspaceId.value}/fields`, { method: 'POST', body: { ...body, entity: form.entity, key: form.key, type: form.type } });
    }
    open.value = false;
    await fields.refresh();
    toast.add({ color: 'success', title: t('fieldsSettings.saved') });
  } catch (e) {
    const details = e instanceof ApiError && Array.isArray(e.details) ? (e.details as Array<{ path: string; message: string }>).map((d) => `${d.path}: ${d.message}`).join('; ') : '';
    error.value = [e instanceof ApiError ? e.message : t('ticket.saveFailed'), details].filter(Boolean).join(' — ');
  }
}

const departmentItems = computed(() => departments.data.value.filter((d) => !d.archived).map((d) => ({ label: d.title, value: d.id })));
</script>

<template>
  <UDashboardPanel id="fields">
    <template #header>
      <UDashboardNavbar :title="t('nav.fields')">
        <template #right>
          <UButton v-if="isAdmin" icon="i-lucide-plus" :label="t('fieldsSettings.add')" @click="edit(null)" />
        </template>
      </UDashboardNavbar>
      <UDashboardToolbar>
        <template #left>
        <UTabs
          v-model="entity"
          :items="[
            { label: t('fieldsSettings.ticketFields'), value: 'ticket' },
            { label: t('fieldsSettings.customerFields'), value: 'customer' },
          ]"
          :content="false"
          size="sm"
        />
        </template>
      </UDashboardToolbar>
    </template>

    <template #body>
      <p class="mb-4 max-w-2xl text-sm text-(--ui-text-muted)">
        {{ t('fieldsSettings.intro') }}
      </p>
      <ResponsiveTable :data="rows" :columns="columns" class="cursor-pointer" :on-select="(_e: Event, row: { original: FieldDefinitionDto }) => isAdmin && edit(row.original)">
        <template #key-cell="{ row }"><code class="text-xs">{{ row.original.key }}</code></template>
        <template #type-cell="{ row }">
          {{ typeLabel(row.original.type) }}
          <span v-if="row.original.optionSet" class="text-xs text-(--ui-text-muted)"> · {{ row.original.optionSet.title }}</span>
        </template>
        <template #fillMode-cell="{ row }">{{ fillLabel(row.original.fillMode) }}</template>
        <template #flags-cell="{ row }">
          <div class="flex gap-1">
            <UBadge v-if="row.original.requiredOn.includes('resolve')" color="warning" variant="subtle">{{ t('fieldsSettings.required') }}</UBadge>
            <UBadge v-if="row.original.archived" color="neutral" variant="subtle">{{ t('departments.archived') }}</UBadge>
          </div>
        </template>
        <template #empty>
          <UEmpty icon="i-lucide-list" :title="t('fieldsSettings.empty')" />
        </template>
      </ResponsiveTable>

      <UModal v-model:open="open" :title="form.id ? t('fieldsSettings.editTitle', { label: form.label }) : t('fieldsSettings.new')" :ui="{ content: 'max-w-2xl' }">
        <template #body>
          <form id="field-form" class="space-y-4" @submit.prevent="save">
            <div class="grid gap-3 sm:grid-cols-3">
              <UFormField :label="t('common.name')" required class="col-span-1"><UInput v-model="form.label" class="w-full" /></UFormField>
              <UFormField :label="t('common.key')" required :help="t('playbooks.keyHelp')"><UInput v-model="form.key" :disabled="Boolean(form.id)" placeholder="dept_number" class="w-full" /></UFormField>
              <UFormField :label="t('fieldsSettings.typeColumn')" :help="t('playbooks.keyHelp')">
                <USelect v-model="form.type" :items="FIELD_TYPES.map((type) => ({ label: typeLabel(type), value: type }))" :disabled="Boolean(form.id)" class="w-full" />
              </UFormField>
            </div>

            <div v-if="hasOptions" class="space-y-2">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <p class="text-sm font-medium">{{ t('fieldsSettings.options') }}</p>
                <UTabs
                  v-model="form.optionsSource"
                  :items="[
                    { label: t('fieldsSettings.optionsManual'), value: 'manual' },
                    { label: t('fieldsSettings.optionsFromSet'), value: 'set' },
                  ]"
                  :content="false"
                  size="xs"
                />
              </div>
              <template v-if="fromSet">
                <USelectMenu
                  v-model="optionSetModel"
                  :items="optionSetItems"
                  value-key="value"
                  :placeholder="t('fieldsSettings.optionSetPlaceholder')"
                  class="w-full"
                />
                <p v-if="optionSetItems.length === 0" class="text-xs text-(--ui-text-muted)">{{ t('fieldsSettings.noOptionSets') }}</p>
                <p v-else class="text-xs text-(--ui-text-muted)">{{ t('fieldsSettings.optionSetHelp') }}</p>
                <div v-if="setPreview.length" class="max-h-40 overflow-y-auto rounded-md border border-(--ui-border) px-2.5 py-1.5 text-xs">
                  <div v-for="option in setPreview" :key="option.value" class="flex gap-2 py-0.5" :class="option.archived ? 'text-(--ui-text-dimmed) line-through' : ''">
                    <code class="shrink-0">{{ option.value }}</code>
                    <span class="truncate">{{ option.label }}<template v-if="option.group"> · {{ option.group }}</template></span>
                  </div>
                </div>
              </template>
              <template v-else>
                <div
                  v-for="(option, index) in form.options"
                  :key="index"
                  class="grid grid-cols-[1fr_1fr_auto_auto] gap-2 sm:grid-cols-[1fr_1fr_2fr_auto_auto]"
                  :class="option.archived ? 'opacity-60' : ''"
                >
                  <UInput v-model="option.value" :placeholder="t('fieldsSettings.optionValue')" size="sm" />
                  <UInput v-model="option.label" :placeholder="t('fieldsSettings.optionLabel')" size="sm" />
                  <!-- On phones the hint takes its own line under the value and the label. -->
                  <UInput v-model="option.agentHint" :placeholder="t('fieldsSettings.optionHint')" size="sm" class="max-sm:order-last max-sm:col-span-4" />
                  <!-- An archived option stays readable in old tickets and cannot be chosen anew. -->
                  <UButton
                    :icon="option.archived ? 'i-lucide-archive-restore' : 'i-lucide-archive'"
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    :aria-label="option.archived ? t('fieldsSettings.restoreOption') : t('fieldsSettings.archiveOption')"
                    :title="option.archived ? t('fieldsSettings.restoreOption') : t('fieldsSettings.archiveOption')"
                    @click="option.archived = !option.archived || undefined"
                  />
                  <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="sm" :aria-label="t('common.delete')" @click="form.options.splice(index, 1)" />
                </div>
                <UButton icon="i-lucide-plus" size="xs" variant="soft" @click="form.options.push({ value: '', label: '' })">{{ t('fieldsSettings.option') }}</UButton>
              </template>
              <UFormField v-if="form.fillMode !== 'manual'" :label="t('fieldsSettings.agentOptions.title')">
                <USelect v-model="form.agentOptionsMode" :items="agentOptionsItems" class="w-full" />
              </UFormField>
            </div>

            <div v-if="form.type === 'number'" class="grid items-end gap-3 sm:grid-cols-3">
              <UCheckbox v-model="form.integer" :label="t('fieldsSettings.integersOnly')" />
              <UFormField :label="t('fieldsSettings.min')"><UInputNumber v-model="form.min" class="w-full" /></UFormField>
              <UFormField :label="t('fieldsSettings.max')"><UInputNumber v-model="form.max" class="w-full" /></UFormField>
            </div>
            <UFormField v-if="form.type === 'text' || form.type === 'textarea'" :label="t('fieldsSettings.pattern')" :help="t('fieldsSettings.patternHelp')">
              <UInput v-model="form.pattern" class="w-full" />
            </UFormField>

            <div class="grid gap-3 sm:grid-cols-2">
              <UFormField :label="t('fieldsSettings.whoFills')">
                <USelect v-model="form.fillMode" :items="FIELD_FILL_MODES.map((m) => ({ label: fillLabel(m), value: m }))" class="w-full" />
              </UFormField>
              <UFormField v-if="form.fillMode === 'agent_auto'" :label="t('fieldsSettings.minConfidence')">
                <UInputNumber v-model="form.agentMinConfidence" :min="0" :max="1" :step="0.05" class="w-full" />
              </UFormField>
            </div>
            <UFormField :label="t('fieldsSettings.agentHint')" :help="t('fieldsSettings.agentHintHelp')">
              <UTextarea v-model="form.agentHint" autoresize :rows="2" class="w-full" :placeholder="t('fieldsSettings.agentHintPlaceholder')" />
            </UFormField>

            <div class="grid gap-3 sm:grid-cols-2">
              <UFormField :label="t('fieldsSettings.whereToShow')">
                <UCheckboxGroup v-model="form.display" :items="FIELD_DISPLAY.map((d) => ({ label: displayLabel(d), value: d }))" />
              </UFormField>
              <div class="space-y-3">
                <UFormField :label="t('nav.departments')" :help="t('fieldsSettings.departmentsHelp')">
                  <USelectMenu v-model="form.scopeDepartmentIds" :items="departmentItems" value-key="value" multiple class="w-full" />
                </UFormField>
                <UCheckbox v-model="form.requiredOnResolve" :label="t('fieldsSettings.requiredOnResolve')" />
                <UCheckbox v-if="form.id" v-model="form.archived" :label="t('departments.inArchive')" />
              </div>
            </div>
            <UAlert v-if="error" color="error" variant="subtle" :title="error" />
          </form>
        </template>
        <template #footer>
          <UButton color="neutral" variant="ghost" @click="open = false">{{ t('common.cancel') }}</UButton>
          <UButton type="submit" form="field-form">{{ t('common.save') }}</UButton>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
