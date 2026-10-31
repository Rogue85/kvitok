<script setup lang="ts">
import type { DepartmentDto, IntegrationDto, IntegrationSyncResultDto, IntegrationToolDto } from '@kvitok/shared';
import type { AccordionItem } from '@nuxt/ui';

const toast = useToast();
const { workspaceId, can } = useWorkspace();
const { departments } = useWorkspaceData();
const isAdmin = computed(() => can('admin'));
const base = computed(() => `/workspaces/${workspaceId.value}/integrations`);

const { data: integrations, refresh } = await useAsyncData(() => `integrations:${workspaceId.value}`, () => api<IntegrationDto[]>(base.value), { default: () => [] });

function replace(integration: IntegrationDto): void {
  integrations.value = integrations.value.map((i) => (i.id === integration.id ? integration : i));
}

/* Status and sync */

function status(integration: IntegrationDto): { label: string; color: 'success' | 'error' | 'neutral' | 'warning' } {
  if (!integration.enabled) return { label: t('integrations.status.disabled'), color: 'neutral' };
  if (integration.lastSyncError) return { label: t('integrations.status.syncError'), color: 'error' };
  if (integration.syncedAt) return { label: t('integrations.status.synced', { time: formatRelative(integration.syncedAt) }), color: 'success' };
  return { label: t('integrations.status.notSynced'), color: 'warning' };
}

function describeSync(sync: IntegrationSyncResultDto): { color: 'success' | 'error' | 'info'; title: string; description?: string } {
  if (sync.status === 'error') return { color: 'error', title: t('integrations.sync.failed'), description: sync.error };
  if (sync.status === 'not_modified') return { color: 'info', title: t('integrations.sync.notModified') };
  const p = sync.playbooks!;
  const parts = [
    p.added.length && t('integrations.sync.added', { count: p.added.length }),
    p.updated.length && t('integrations.sync.updated', { count: p.updated.length }),
    p.removed.length && t('integrations.sync.removed', { count: p.removed.length }),
    p.skipped.length && t('integrations.sync.skipped', { playbooks: p.skipped.map((s) => `${s.key} (${s.reason})`).join(', ') }),
  ].filter(Boolean);
  return { color: 'success', title: t('integrations.sync.updatedTitle'), description: parts.join('; ') || t('integrations.sync.noPlaybookChanges') };
}

const syncing = ref<string | null>(null);
async function sync(integration: IntegrationDto, force = false): Promise<void> {
  syncing.value = integration.id;
  try {
    const result = await api<{ integration: IntegrationDto; sync: IntegrationSyncResultDto }>(`${base.value}/${integration.id}/sync`, { method: 'POST', body: { force } });
    replace(result.integration);
    toast.add(describeSync(result.sync));
  } catch (e) {
    toast.add({ color: 'error', title: e instanceof ApiError ? e.message : t('integrations.sync.error') });
  } finally {
    syncing.value = null;
  }
}

async function toggle(integration: IntegrationDto, enabled: boolean): Promise<void> {
  try {
    replace(await api<IntegrationDto>(`${base.value}/${integration.id}`, { method: 'PATCH', body: { enabled } }));
  } catch (e) {
    toast.add({ color: 'error', title: e instanceof ApiError ? e.message : t('ticket.saveFailed') });
  }
}

/* Departments from the manifest */

const selectedDepartments = reactive<Record<string, string[]>>({});
async function importDepartments(integration: IntegrationDto): Promise<void> {
  const keys = selectedDepartments[integration.id] ?? [];
  try {
    const created = await api<DepartmentDto[]>(`${base.value}/${integration.id}/import-departments`, { method: 'POST', body: { keys } });
    selectedDepartments[integration.id] = [];
    await Promise.all([refresh(), departments.refresh()]);
    toast.add({ color: 'success', title: t('integrations.departmentsCreated', { count: created.length }), description: created.map((d) => d.title).join(', ') });
  } catch (e) {
    toast.add({ color: 'error', title: e instanceof ApiError ? e.message : t('integrations.importFailed') });
  }
}

/* Form */

const open = ref(false);
const draft = reactive({ id: null as string | null, name: '', baseUrl: '', secret: '', enabled: true });
const editing = computed(() => draft.id !== null);
const formError = ref<string | null>(null);
const saving = ref(false);

function edit(integration: IntegrationDto | null): void {
  Object.assign(draft, integration ? { id: integration.id, name: integration.name, baseUrl: integration.baseUrl, secret: '', enabled: integration.enabled } : { id: null, name: '', baseUrl: '', secret: '', enabled: true });
  formError.value = null;
  open.value = true;
}

async function save(): Promise<void> {
  formError.value = null;
  saving.value = true;
  try {
    if (draft.id) {
      const body = { name: draft.name, baseUrl: draft.baseUrl, enabled: draft.enabled, ...(draft.secret ? { secret: draft.secret } : {}) };
      replace(await api<IntegrationDto>(`${base.value}/${draft.id}`, { method: 'PATCH', body }));
      open.value = false;
      toast.add({ color: 'success', title: t('integrations.saved'), description: t('integrations.savedHint') });
    } else {
      const result = await api<{ integration: IntegrationDto; sync: IntegrationSyncResultDto }>(base.value, { method: 'POST', body: { name: draft.name, baseUrl: draft.baseUrl, secret: draft.secret, enabled: draft.enabled } });
      integrations.value = [...integrations.value, result.integration];
      open.value = false;
      toast.add(describeSync(result.sync));
    }
  } catch (e) {
    formError.value = e instanceof ApiError ? e.message : t('ticket.saveFailed');
  } finally {
    saving.value = false;
  }
}

async function remove(): Promise<void> {
  if (!draft.id || !confirm(t('integrations.confirmDelete'))) return;
  await api(`${base.value}/${draft.id}`, { method: 'DELETE' });
  open.value = false;
  await refresh();
}

/* Manifest view */

const paramsLabel = (params: IntegrationToolDto['params']) =>
  params.length ? params.map((p) => `${p.name}${p.required ? '' : '?'}: ${p.type}`).join(', ') : t('integrations.noParams');

function sections(integration: IntegrationDto): AccordionItem[] {
  const m = integration.manifest!;
  return [
    { label: t('integrations.sections.tools', { count: m.tools.length }), icon: 'i-lucide-database', slot: 'tools' as const, value: 'tools' },
    { label: t('integrations.sections.actions', { count: m.actions.length }), icon: 'i-lucide-zap', slot: 'actions' as const, value: 'actions' },
    { label: t('integrations.sections.instructions'), icon: 'i-lucide-book-open-text', slot: 'instructions' as const, value: 'instructions', disabled: !m.instructions },
    { label: t('integrations.sections.departments', { count: m.suggestedDepartments.length }), icon: 'i-lucide-users', slot: 'departments' as const, value: 'departments', disabled: m.suggestedDepartments.length === 0 },
  ];
}
</script>

<template>
  <UDashboardPanel id="integrations">
    <template #header>
      <UDashboardNavbar :title="t('nav.integrations')">
        <template #right>
          <UButton v-if="isAdmin" icon="i-lucide-plug" :label="t('integrations.connect')" @click="edit(null)" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <p class="mb-4 max-w-3xl text-sm text-(--ui-text-muted)">
        {{ t('integrations.intro') }}
      </p>

      <UEmpty
        v-if="integrations.length === 0"
        icon="i-lucide-plug"
        :title="t('integrations.empty.title')"
        :description="t('integrations.empty.description')"
      />

      <div class="space-y-4">
        <UCard v-for="integration in integrations" :key="integration.id">
          <template #header>
            <div class="flex flex-wrap items-start gap-3">
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <p class="font-medium">{{ integration.name }}</p>
                  <UBadge :color="status(integration).color" variant="subtle" size="sm">{{ status(integration).label }}</UBadge>
                </div>
                <p class="mt-0.5 truncate font-mono text-xs text-(--ui-text-muted)">{{ integration.baseUrl }}</p>
                <p v-if="integration.manifest" class="mt-1 text-xs text-(--ui-text-muted)">
                  {{ integration.manifest.title }} · <code>{{ integration.manifest.name }}</code> · {{ t('integrations.protocol', { version: integration.manifest.protocolVersion }) }}
                  <template v-if="integration.manifest.identityTypes.length"> · {{ t('integrations.identityTypes', { types: integration.manifest.identityTypes.join(', ') }) }}</template>
                </p>
              </div>
              <div v-if="isAdmin" class="flex items-center gap-2">
                <USwitch :model-value="integration.enabled" @update:model-value="(v: boolean) => toggle(integration, v)" />
                <UButton
                  color="neutral"
                  variant="outline"
                  icon="i-lucide-refresh-cw"
                  :label="t('integrations.syncNow')"
                  :loading="syncing === integration.id"
                  :disabled="!integration.enabled"
                  @click="sync(integration)"
                />
                <UButton color="neutral" variant="ghost" icon="i-lucide-settings-2" :aria-label="t('common.edit')" @click="edit(integration)" />
              </div>
            </div>
          </template>

          <UAlert
            v-if="integration.lastSyncError"
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            class="mb-4"
            :title="integration.lastSyncError"
            :description="integration.manifest ? t('integrations.lastManifestInUse') : t('integrations.noManifestYet')"
          />

          <UAccordion v-if="integration.manifest" type="multiple" :items="sections(integration)" :ui="{ trigger: 'text-sm' }">
            <template #tools>
              <ul class="divide-y divide-(--ui-border) text-sm">
                <li v-for="tool in integration.manifest.tools" :key="tool.name" class="py-2">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-medium">{{ tool.title }}</span>
                    <code class="text-xs text-(--ui-text-muted)">{{ tool.name }}</code>
                    <UBadge v-if="!tool.requiresCustomer" color="info" variant="subtle" size="sm">{{ t('integrations.noCustomerNeeded') }}</UBadge>
                    <UBadge color="neutral" variant="outline" size="sm">{{ tool.display }}</UBadge>
                    <UBadge color="neutral" variant="outline" size="sm">{{ t('integrations.cache', { seconds: tool.cacheTtlSeconds }) }}</UBadge>
                  </div>
                  <p class="mt-0.5 text-(--ui-text-muted)">{{ tool.description }}</p>
                  <p class="mt-0.5 font-mono text-xs text-(--ui-text-dimmed)">{{ paramsLabel(tool.params) }}</p>
                </li>
              </ul>
            </template>
            <template #actions>
              <ul class="divide-y divide-(--ui-border) text-sm">
                <li v-for="action in integration.manifest.actions" :key="action.name" class="py-2">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-medium">{{ action.title }}</span>
                    <code class="text-xs text-(--ui-text-muted)">{{ action.name }}</code>
                    <UBadge v-if="action.requiresApproval" color="warning" variant="subtle" size="sm">{{ t('integrations.requiresApproval') }}</UBadge>
                  </div>
                  <p class="mt-0.5 whitespace-pre-line text-(--ui-text-muted)">{{ action.description }}</p>
                  <p class="mt-0.5 font-mono text-xs text-(--ui-text-dimmed)">{{ paramsLabel(action.params) }}</p>
                </li>
              </ul>
            </template>
            <template #instructions>
              <p class="mb-2 text-xs text-(--ui-text-muted)">{{ t('integrations.instructionsHint') }}</p>
              <pre class="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-(--ui-bg-elevated) p-3 text-xs">{{ integration.manifest.instructions }}</pre>
            </template>
            <template #departments>
              <UCheckboxGroup
                v-model="selectedDepartments[integration.id]"
                :items="integration.manifest.suggestedDepartments.map((d) => ({ value: d.key, label: d.title, description: d.exists ? t('integrations.departmentExists', { key: d.key }) : d.description, disabled: d.exists }))"
              />
              <UButton
                v-if="isAdmin"
                class="mt-3"
                size="sm"
                icon="i-lucide-download"
                :label="t('integrations.createDepartments')"
                :disabled="!selectedDepartments[integration.id]?.length"
                @click="importDepartments(integration)"
              />
            </template>
          </UAccordion>
          <p v-if="integration.manifest" class="mt-3 text-xs text-(--ui-text-muted)">
            {{ t('integrations.playbooksFromManifest', { count: integration.manifest.playbookKeys.length }) }}
            <NuxtLink :to="`/w/${workspaceId}/settings/playbooks`" class="underline">{{ t('integrations.inPlaybooks') }}</NuxtLink>{{ t('integrations.canBeDisabled') }}
          </p>
        </UCard>
      </div>

      <UModal v-model:open="open" :title="draft.id ? t('integrations.integration') : t('integrations.connect')" :ui="{ content: 'max-w-lg' }">
        <template #body>
          <form id="integration-form" class="space-y-4" @submit.prevent="save">
            <UFormField :label="t('common.name')" required><UInput v-model="draft.name" placeholder="Acme Coffee" class="w-full" /></UFormField>
            <UFormField :label="t('integrations.address')" required :help="t('integrations.addressHelp')">
              <UInput v-model="draft.baseUrl" placeholder="https://example.com/api/support" class="w-full font-mono" />
            </UFormField>
            <UFormField :label="t('integrations.secret')" :required="!draft.id" :help="draft.id ? t('integrations.secretKeep') : t('integrations.secretHelp')">
              <UInput v-model="draft.secret" type="password" autocomplete="new-password" class="w-full" />
            </UFormField>
            <UCheckbox v-model="draft.enabled" :label="t('integrations.enabled')" />
            <UAlert v-if="formError" color="error" variant="subtle" :title="formError" />
          </form>
        </template>
        <template #footer>
          <UButton v-if="editing" color="error" variant="ghost" icon="i-lucide-trash-2" class="mr-auto" @click="remove">{{ t('common.delete') }}</UButton>
          <UButton color="neutral" variant="ghost" @click="open = false">{{ t('common.cancel') }}</UButton>
          <UButton type="submit" form="integration-form" :loading="saving">{{ editing ? t('common.save') : t('integrations.connectShort') }}</UButton>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
