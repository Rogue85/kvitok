<script setup lang="ts">
import type { DepartmentDto } from '@kvitok/shared';
import type { TableColumn } from '@nuxt/ui';

const toast = useToast();
const { workspaceId, can } = useWorkspace();
const { departments } = useWorkspaceData();
const isAdmin = computed(() => can('admin'));

const columns: TableColumn<DepartmentDto>[] = [
  { accessorKey: 'title', header: t('departments.department') },
  { accessorKey: 'key', header: t('common.key') },
  { accessorKey: 'description', header: t('departments.descriptionForAgent') },
  { id: 'flags', header: '' },
];

interface DepartmentForm {
  id: string | null;
  key: string;
  title: string;
  description: string;
  examples: string;
  instructions: string;
  isTriage: boolean;
  archived: boolean;
}
const empty = (): DepartmentForm => ({ id: null, key: '', title: '', description: '', examples: '', instructions: '', isTriage: false, archived: false });
const open = ref(false);
const form = reactive<DepartmentForm>(empty());
const error = ref<string | null>(null);

function edit(department: DepartmentDto | null): void {
  Object.assign(
    form,
    department
      ? { ...department, examples: department.examples.join('\n') }
      : empty(),
  );
  error.value = null;
  open.value = true;
}

async function save(): Promise<void> {
  error.value = null;
  const body = {
    title: form.title,
    description: form.description,
    examples: form.examples.split('\n').map((s) => s.trim()).filter(Boolean),
    instructions: form.instructions,
    isTriage: form.isTriage,
  };
  try {
    if (form.id) {
      await api(`/workspaces/${workspaceId.value}/departments/${form.id}`, { method: 'PATCH', body: { ...body, archived: form.archived } });
    } else {
      await api(`/workspaces/${workspaceId.value}/departments`, { method: 'POST', body: { ...body, key: form.key } });
    }
    open.value = false;
    await departments.refresh();
    toast.add({ color: 'success', title: t('departments.saved') });
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : t('ticket.saveFailed');
  }
}
</script>

<template>
  <UDashboardPanel id="departments">
    <template #header>
      <UDashboardNavbar :title="t('nav.departments')">
        <template #right>
          <UButton v-if="isAdmin" icon="i-lucide-plus" :label="t('departments.add')" @click="edit(null)" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <p class="mb-4 max-w-2xl text-sm text-(--ui-text-muted)">
        {{ t('departments.intro') }}
      </p>
      <ResponsiveTable :data="departments.data.value" :columns="columns" class="cursor-pointer" :on-select="(_e: Event, row: { original: DepartmentDto }) => isAdmin && edit(row.original)">
        <template #description-cell="{ row }">
          <p class="max-w-md truncate text-(--ui-text-muted)">{{ row.original.description || '—' }}</p>
        </template>
        <template #flags-cell="{ row }">
          <div class="flex gap-1">
            <UBadge v-if="row.original.isTriage" color="info" variant="subtle">{{ t('departments.triage') }}</UBadge>
            <UBadge v-if="row.original.archived" color="neutral" variant="subtle">{{ t('departments.archived') }}</UBadge>
          </div>
        </template>
        <template #empty>
          <UEmpty icon="i-lucide-users" :title="t('departments.empty.title')" :description="t('departments.empty.description')" />
        </template>
      </ResponsiveTable>

      <UModal v-model:open="open" :title="form.id ? t('departments.department') : t('departments.new')" :ui="{ content: 'max-w-xl' }">
        <template #body>
          <form id="department-form" class="space-y-4" @submit.prevent="save">
            <div class="grid gap-3 sm:grid-cols-2">
              <UFormField :label="t('common.name')" required><UInput v-model="form.title" class="w-full" /></UFormField>
              <UFormField :label="t('common.key')" required :help="t('departments.keyHelp')"><UInput v-model="form.key" :disabled="Boolean(form.id)" class="w-full" /></UFormField>
            </div>
            <UFormField :label="t('departments.descriptionForAgent')" :help="t('departments.descriptionHelp')">
              <UTextarea v-model="form.description" autoresize :rows="2" class="w-full" />
            </UFormField>
            <UFormField :label="t('departments.examples')" :help="t('departments.examplesHelp')">
              <UTextarea v-model="form.examples" autoresize :rows="3" class="w-full" />
            </UFormField>
            <UFormField :label="t('departments.instructions')" :help="t('departments.instructionsHelp')">
              <UTextarea v-model="form.instructions" autoresize :rows="3" class="w-full" />
            </UFormField>
            <div class="flex gap-6">
              <UCheckbox v-model="form.isTriage" :label="t('departments.isTriage')" />
              <UCheckbox v-if="form.id" v-model="form.archived" :label="t('departments.inArchive')" />
            </div>
            <UAlert v-if="error" color="error" variant="subtle" :title="error" />
          </form>
        </template>
        <template #footer>
          <UButton color="neutral" variant="ghost" @click="open = false">{{ t('common.cancel') }}</UButton>
          <UButton type="submit" form="department-form">{{ t('common.save') }}</UButton>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
