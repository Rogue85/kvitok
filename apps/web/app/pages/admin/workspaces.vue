<script setup lang="ts">
import { getLocale } from '@kvitok/i18n';
import { CreateWorkspaceSchema, slugify, type CreateWorkspaceInput, type WorkspaceDto } from '@kvitok/shared';
import type { FormSubmitEvent, TableColumn } from '@nuxt/ui';

definePageMeta({ superadmin: true });

const { me, fetchMe } = useAuth();
const { data: workspaces, refresh, status } = await useAsyncData('admin:workspaces', () => api<WorkspaceDto[]>('/workspaces'), {
  default: () => [],
});
const memberOf = computed(() => new Set(me.value?.workspaces.filter((w) => w.isMember).map((w) => w.workspaceId)));

const columns: TableColumn<WorkspaceDto>[] = [
  { accessorKey: 'name', header: t('common.name') },
  { accessorKey: 'slug', header: 'Slug' },
  { accessorKey: 'currency', header: t('generalSettings.currency') },
  { accessorKey: 'createdAt', header: t('adminWorkspaces.created') },
];

const currencies = currencyItems();
const open = ref(false);
const state = reactive<{ name: string; slug: string; currency: string }>({ name: '', slug: '', currency: 'USD' });
/* The slug follows the name until it is edited by hand. */
const slugEdited = ref(false);
watch(
  () => state.name,
  (name) => {
    if (!slugEdited.value) state.slug = slugify(name);
  },
);
const error = ref<string | null>(null);

function startCreate(): void {
  Object.assign(state, { name: '', slug: '', currency: getLocale() === 'ru' ? 'RUB' : 'USD' });
  slugEdited.value = false;
  error.value = null;
  open.value = true;
}

async function onCreate(event: FormSubmitEvent<CreateWorkspaceInput>): Promise<void> {
  error.value = null;
  try {
    const workspace = await api<WorkspaceDto>('/workspaces', { method: 'POST', body: event.data });
    open.value = false;
    await Promise.all([refresh(), fetchMe()]);
    await navigateTo(`/w/${workspace.id}/settings/general`);
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : t('workspaceSetup.createFailed');
  }
}
</script>

<template>
  <UDashboardPanel id="admin-workspaces">
    <template #header>
      <UDashboardNavbar :title="t('nav.workspaces')">
        <template #right>
          <UButton icon="i-lucide-plus" :label="t('workspaceSetup.create')" @click="startCreate" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <p class="mb-4 max-w-2xl text-sm text-(--ui-text-muted)">{{ t('adminWorkspaces.intro') }}</p>
      <ResponsiveTable :data="workspaces" :columns="columns" :loading="status === 'pending'">
        <template #name-cell="{ row }">
          <div class="flex items-center gap-2">
            <NuxtLink :to="`/w/${row.original.id}/tickets`" class="font-medium hover:underline">{{ row.original.name }}</NuxtLink>
            <UBadge v-if="!memberOf.has(row.original.id)" color="neutral" variant="subtle">{{ t('adminWorkspaces.notMember') }}</UBadge>
          </div>
        </template>
        <template #slug-cell="{ row }"><span class="font-mono text-sm">{{ row.original.slug }}</span></template>
        <template #createdAt-cell="{ row }">{{ formatDate(row.original.createdAt) }}</template>
      </ResponsiveTable>

      <UModal v-model:open="open" :title="t('workspaceSetup.create')">
        <template #body>
          <UForm id="workspace-form" :schema="CreateWorkspaceSchema" :state="state" class="space-y-4" @submit="onCreate">
            <UFormField :label="t('common.name')" name="name">
              <UInput v-model="state.name" class="w-full" autofocus />
            </UFormField>
            <UFormField label="Slug" name="slug" :help="t('workspaceSetup.slugHelp')">
              <UInput v-model="state.slug" class="w-full font-mono" @update:model-value="slugEdited = true" />
            </UFormField>
            <UFormField :label="t('generalSettings.currency')" name="currency" :help="t('generalSettings.currencyHelp')">
              <USelectMenu v-model="state.currency" :items="currencies" value-key="value" class="w-full" />
            </UFormField>
            <UAlert v-if="error" color="error" variant="subtle" :title="error" />
          </UForm>
        </template>
        <template #footer>
          <UButton color="neutral" variant="ghost" @click="open = false">{{ t('common.cancel') }}</UButton>
          <UButton type="submit" form="workspace-form">{{ t('common.create') }}</UButton>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
