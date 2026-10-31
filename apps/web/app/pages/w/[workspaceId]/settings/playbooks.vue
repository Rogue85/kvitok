<script setup lang="ts">
import type { IntegrationDto, PlaybookDto } from '@kvitok/shared';
import type { TableColumn } from '@nuxt/ui';

const toast = useToast();
const { workspaceId, can } = useWorkspace();
const { departments } = useWorkspaceData();
const isAdmin = computed(() => can('admin'));
const base = computed(() => `/workspaces/${workspaceId.value}/playbooks`);

const { data: playbooks, refresh } = await useAsyncData(() => `playbooks:${workspaceId.value}`, () => api<PlaybookDto[]>(base.value), { default: () => [] });
const { data: integrations } = await useAsyncData(
  () => `integrations:${workspaceId.value}`,
  () => api<IntegrationDto[]>(`/workspaces/${workspaceId.value}/integrations`),
  { default: () => [] },
);
const integrationName = (id: string | null) => integrations.value.find((i) => i.id === id)?.name ?? t('events.integrationFallback');

const columns: TableColumn<PlaybookDto>[] = [
  { accessorKey: 'title', header: t('playbooks.playbook') },
  { accessorKey: 'key', header: t('common.key') },
  { accessorKey: 'when', header: t('playbooks.when') },
  { id: 'flags', header: '' },
];

const open = ref(false);
const form = reactive({ id: null as string | null, key: '', title: '', when: '', body: '', departmentId: 'none', enabled: true, integrationId: null as string | null });
/** A playbook from a manifest is edited in the integration backend: here it can only be enabled or disabled. */
const fromManifest = computed(() => form.integrationId !== null);
function edit(playbook: PlaybookDto | null): void {
  Object.assign(
    form,
    playbook
      ? { ...playbook, departmentId: playbook.departmentId ?? 'none' }
      : { id: null, key: '', title: '', when: '', body: '', departmentId: 'none', enabled: true, integrationId: null },
  );
  open.value = true;
}
const departmentItems = computed(() => [{ label: t('playbooks.anyDepartment'), value: 'none' }, ...departments.data.value.map((d) => ({ label: d.title, value: d.id }))]);

async function save(): Promise<void> {
  const body = fromManifest.value
    ? { enabled: form.enabled }
    : { title: form.title, when: form.when, body: form.body, departmentId: form.departmentId === 'none' ? null : form.departmentId, enabled: form.enabled };
  try {
    if (form.id) await api(`${base.value}/${form.id}`, { method: 'PATCH', body });
    else await api(base.value, { method: 'POST', body: { ...body, key: form.key } });
    open.value = false;
    await refresh();
  } catch (e) {
    toast.add({ color: 'error', title: e instanceof ApiError ? e.message : t('ticket.saveFailed') });
  }
}
async function remove(): Promise<void> {
  if (!form.id) return;
  await api(`${base.value}/${form.id}`, { method: 'DELETE' });
  open.value = false;
  await refresh();
}
</script>

<template>
  <UDashboardPanel id="playbooks">
    <template #header>
      <UDashboardNavbar :title="t('nav.playbooks')">
        <template #right>
          <UButton v-if="isAdmin" icon="i-lucide-plus" :label="t('playbooks.add')" @click="edit(null)" />
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <p class="mb-4 max-w-3xl text-sm text-(--ui-text-muted)">
        {{ t('playbooks.intro') }}
      </p>
      <UTable :data="playbooks" :columns="columns" class="cursor-pointer" :on-select="(_e: Event, row: { original: PlaybookDto }) => isAdmin && edit(row.original)">
        <template #key-cell="{ row }"><code class="text-xs">{{ row.original.key }}</code></template>
        <template #when-cell="{ row }"><p class="max-w-md truncate text-(--ui-text-muted)">{{ row.original.when }}</p></template>
        <template #flags-cell="{ row }">
          <div class="flex gap-1">
            <UBadge v-if="row.original.integrationId" color="info" variant="subtle" size="sm" icon="i-lucide-plug">{{ integrationName(row.original.integrationId) }}</UBadge>
            <UBadge color="neutral" variant="outline" size="sm">v{{ row.original.version }}</UBadge>
            <UBadge v-if="!row.original.enabled" color="neutral" variant="subtle" size="sm">{{ t('playbooks.disabled') }}</UBadge>
          </div>
        </template>
        <template #empty><UEmpty icon="i-lucide-book-open" :title="t('playbooks.empty.title')" :description="t('playbooks.empty.description')" /></template>
      </UTable>

      <UModal v-model:open="open" :title="form.id ? t('playbooks.playbook') : t('playbooks.new')" :ui="{ content: 'max-w-3xl' }">
        <template #body>
          <form id="playbook-form" class="space-y-4" @submit.prevent="save">
            <UAlert
              v-if="fromManifest"
              color="info"
              variant="subtle"
              icon="i-lucide-plug"
              :title="t('playbooks.fromIntegration', { integration: integrationName(form.integrationId) })"
              :description="t('playbooks.fromIntegrationHint')"
            />
            <div class="grid grid-cols-3 gap-3">
              <UFormField :label="t('common.name')" required class="col-span-2"><UInput v-model="form.title" :disabled="fromManifest" class="w-full" /></UFormField>
              <UFormField :label="t('common.key')" required :help="t('playbooks.keyHelp')"><UInput v-model="form.key" :disabled="Boolean(form.id)" placeholder="missing_points" class="w-full" /></UFormField>
            </div>
            <UFormField :label="t('playbooks.when')" required :help="t('playbooks.whenHelp')">
              <UInput v-model="form.when" :disabled="fromManifest" :placeholder="t('playbooks.whenPlaceholder')" class="w-full" />
            </UFormField>
            <UFormField :label="t('playbooks.body')" required :help="t('playbooks.bodyHelp')">
              <UTextarea v-model="form.body" :disabled="fromManifest" autoresize :rows="12" class="w-full font-mono text-xs" />
            </UFormField>
            <div class="flex items-end gap-4">
              <UFormField :label="t('playbooks.defaultDepartment')" class="w-64"><USelect v-model="form.departmentId" :items="departmentItems" :disabled="fromManifest" class="w-full" /></UFormField>
              <UCheckbox v-model="form.enabled" :label="t('playbooks.enabled')" />
            </div>
          </form>
        </template>
        <template #footer>
          <UButton v-if="form.id && !fromManifest" color="error" variant="ghost" icon="i-lucide-trash-2" class="mr-auto" @click="remove">{{ t('common.delete') }}</UButton>
          <UButton color="neutral" variant="ghost" @click="open = false">{{ t('common.cancel') }}</UButton>
          <UButton type="submit" form="playbook-form">{{ t('common.save') }}</UButton>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
