<script setup lang="ts">
import { API_TOKEN_PREFIX, API_TOKEN_SCOPES, type ApiTokenDto, type ApiTokenScope, type CreatedApiTokenDto } from '@kvitok/shared';
import type { TableColumn } from '@nuxt/ui';

const toast = useToast();
const { me } = useAuth();
const { workspaceId } = useWorkspace();

const { data: tokens, refresh, status } = await useAsyncData('tokens', () => api<ApiTokenDto[]>('/tokens'), { default: () => [] });

const columns: TableColumn<ApiTokenDto>[] = [
  { accessorKey: 'name', header: t('common.name') },
  { accessorKey: 'scopes', header: t('tokens.scopes') },
  { accessorKey: 'workspaceName', header: t('tokens.workspace') },
  { accessorKey: 'lastUsedAt', header: t('tokens.lastUsed') },
  { accessorKey: 'expiresAt', header: t('tokens.expires') },
  { id: 'actions', header: '' },
];

/* workspaces:create makes sense only for a superadmin and without a workspace restriction. */
const scopeItems = computed(() =>
  API_TOKEN_SCOPES.filter((scope) => scope !== 'workspaces:create' || me.value?.user.isSuperadmin).map((value) => ({
    value,
    label: value,
    description: t(`tokens.scope.${value}`),
  })),
);
/* A select item cannot have an empty value, so "every workspace" has its own. */
const ALL_WORKSPACES = 'all';
const workspaceItems = computed(() => [
  { label: t('tokens.allWorkspaces'), value: ALL_WORKSPACES },
  ...(me.value?.memberships ?? []).map((m) => ({ label: m.workspaceName, value: m.workspaceId })),
]);
const expiryItems = [
  { label: t('tokens.expiry.d30'), value: 30 },
  { label: t('tokens.expiry.d90'), value: 90 },
  { label: t('tokens.expiry.d365'), value: 365 },
  { label: t('tokens.expiry.never'), value: 0 },
];

interface TokenForm {
  name: string;
  scopes: ApiTokenScope[];
  workspaceId: string;
  expiresInDays: number;
}
const empty = (): TokenForm => ({ name: '', scopes: ['read'], workspaceId: workspaceId.value, expiresInDays: 90 });
const open = ref(false);
const form = reactive<TokenForm>(empty());
const error = ref<string | null>(null);
/* The token is shown once — right after creation. */
const secret = ref<string | null>(null);

function startCreate(): void {
  Object.assign(form, empty());
  error.value = null;
  open.value = true;
}

async function create(): Promise<void> {
  error.value = null;
  try {
    const result = await api<CreatedApiTokenDto>('/tokens', {
      method: 'POST',
      body: {
        name: form.name,
        scopes: form.scopes,
        workspaceId: form.workspaceId === ALL_WORKSPACES ? null : form.workspaceId,
        expiresInDays: form.expiresInDays || null,
      },
    });
    open.value = false;
    secret.value = result.secret;
    await refresh();
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : t('tokens.createFailed');
  }
}

async function revoke(token: ApiTokenDto): Promise<void> {
  try {
    await api(`/tokens/${token.id}`, { method: 'DELETE' });
    toast.add({ color: 'success', title: t('tokens.revoked', { name: token.name }) });
  } catch (e) {
    toast.add({ color: 'error', title: e instanceof ApiError ? e.message : t('common.error') });
  }
  await refresh();
}

async function copy(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  toast.add({ title: t('common.copied'), icon: 'i-lucide-copy' });
}
</script>

<template>
  <UDashboardPanel id="tokens">
    <template #header>
      <UDashboardNavbar :title="t('nav.tokens')">
        <template #right>
          <UButton icon="i-lucide-plus" :label="t('tokens.new')" @click="startCreate" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <p class="mb-4 max-w-2xl text-sm text-(--ui-text-muted)">
        {{ t('tokens.intro') }}
      </p>
      <UTable :data="tokens" :columns="columns" :loading="status === 'pending'">
        <template #name-cell="{ row }">
          <p class="font-medium">{{ row.original.name }}</p>
          <p class="font-mono text-xs text-(--ui-text-muted)">{{ API_TOKEN_PREFIX }}…{{ row.original.hint }}</p>
        </template>
        <template #scopes-cell="{ row }">
          <div class="flex flex-wrap gap-1">
            <UBadge v-for="scope in row.original.scopes" :key="scope" color="neutral" variant="subtle" class="font-mono">{{ scope }}</UBadge>
          </div>
        </template>
        <template #workspaceName-cell="{ row }">
          {{ row.original.workspaceName ?? t('tokens.allWorkspaces') }}
        </template>
        <template #lastUsedAt-cell="{ row }">
          <span class="text-(--ui-text-muted)">{{ row.original.lastUsedAt ? formatRelative(row.original.lastUsedAt) : t('tokens.notUsed') }}</span>
        </template>
        <template #expiresAt-cell="{ row }">
          <span class="text-(--ui-text-muted)">{{ row.original.expiresAt ? formatDate(row.original.expiresAt) : t('tokens.noExpiry') }}</span>
        </template>
        <template #actions-cell="{ row }">
          <UButton icon="i-lucide-ban" color="error" variant="ghost" :label="t('tokens.revoke')" @click="revoke(row.original)" />
        </template>
        <template #empty>
          <UEmpty icon="i-lucide-key-round" :title="t('tokens.empty')" />
        </template>
      </UTable>

      <UModal v-model:open="open" :title="t('tokens.new')" :ui="{ content: 'max-w-xl' }">
        <template #body>
          <form id="token-form" class="space-y-4" @submit.prevent="create">
            <UFormField :label="t('common.name')" required>
              <UInput v-model="form.name" :placeholder="t('tokens.namePlaceholder')" class="w-full" />
            </UFormField>
            <UFormField :label="t('tokens.scopes')" required>
              <UCheckboxGroup v-model="form.scopes" :items="scopeItems" :ui="{ label: 'font-mono' }" />
            </UFormField>
            <div class="grid grid-cols-2 gap-3">
              <UFormField :label="t('tokens.workspace')">
                <USelect v-model="form.workspaceId" :items="workspaceItems" class="w-full" />
              </UFormField>
              <UFormField :label="t('tokens.expires')">
                <USelect v-model="form.expiresInDays" :items="expiryItems" class="w-full" />
              </UFormField>
            </div>
            <UAlert v-if="error" color="error" variant="subtle" :title="error" />
          </form>
        </template>
        <template #footer>
          <UButton color="neutral" variant="ghost" @click="open = false">{{ t('common.cancel') }}</UButton>
          <UButton type="submit" form="token-form">{{ t('common.create') }}</UButton>
        </template>
      </UModal>

      <UModal :open="secret !== null" :title="t('tokens.secret.title')" :description="t('tokens.secret.description')" @update:open="(v: boolean) => !v && (secret = null)">
        <template #body>
          <div v-if="secret" class="flex gap-2">
            <UInput :model-value="secret" readonly class="flex-1 font-mono" />
            <UButton icon="i-lucide-copy" color="neutral" variant="soft" @click="copy(secret)" />
          </div>
        </template>
        <template #footer>
          <UButton @click="secret = null">{{ t('tokens.secret.saved') }}</UButton>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
