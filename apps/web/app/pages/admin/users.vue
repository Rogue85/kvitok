<script setup lang="ts">
import {
  WORKSPACE_ROLES,
  type AdminUserDto,
  type AuditLogDto,
  type PasswordLinkDto,
  type WorkspaceDto,
  type WorkspaceRole,
} from '@kvitok/shared';
import type { TableColumn } from '@nuxt/ui';

definePageMeta({ superadmin: true });

const toast = useToast();
const { me, fetchMe } = useAuth();

const { data: users, refresh, status } = await useAsyncData('admin:users', () => api<AdminUserDto[]>('/admin/users'), { default: () => [] });
const { data: workspaces } = await useAsyncData('admin:workspaces', () => api<WorkspaceDto[]>('/workspaces'), { default: () => [] });

const columns: TableColumn<AdminUserDto>[] = [
  { accessorKey: 'name', header: t('members.name') },
  { accessorKey: 'status', header: t('users.statusColumn') },
  { id: 'access', header: t('users.access') },
  { accessorKey: 'lastSeenAt', header: t('users.lastSeen') },
  { id: 'actions', header: '' },
];

/* A select item cannot have an empty value, so "no access" has its own. */
const NO_ACCESS = 'none';
type Access = WorkspaceRole | typeof NO_ACCESS;
const accessItems = [
  { label: t('users.noAccess'), value: NO_ACCESS },
  ...WORKSPACE_ROLES.map((value) => ({ label: t(`members.role.${value}`), value })),
];

function notifyError(error: unknown): void {
  toast.add({ color: 'error', title: error instanceof ApiError ? error.message : t('common.actionFailed') });
}

const link = ref<PasswordLinkDto | null>(null);
const linkName = ref('');
function showLink(value: PasswordLinkDto, name: string): void {
  link.value = value;
  linkName.value = name;
}

// Creating a user: an invitation with access to chosen workspaces.
const createOpen = ref(false);
const createState = reactive<{ email: string; name: string; isSuperadmin: boolean; access: Record<string, Access> }>({
  email: '',
  name: '',
  isSuperadmin: false,
  access: {},
});
const createError = ref<string | null>(null);

function startCreate(): void {
  Object.assign(createState, { email: '', name: '', isSuperadmin: false, access: {} });
  createError.value = null;
  createOpen.value = true;
}

async function create(): Promise<void> {
  createError.value = null;
  const memberships = Object.entries(createState.access)
    .filter(([, role]) => role !== NO_ACCESS)
    .map(([workspaceId, role]) => ({ workspaceId, role }));
  try {
    const result = await api<{ user: AdminUserDto; link: PasswordLinkDto }>('/admin/users', {
      method: 'POST',
      body: { email: createState.email, name: createState.name, isSuperadmin: createState.isSuperadmin, memberships },
    });
    createOpen.value = false;
    showLink(result.link, result.user.name);
    await refresh();
  } catch (e) {
    createError.value = e instanceof ApiError ? e.message : t('users.createFailed');
  }
}

// Editing a user in a side panel.
const editing = ref<AdminUserDto | null>(null);
const editName = ref('');
const history = ref<AuditLogDto[]>([]);
const isSelf = computed(() => editing.value?.id === me.value?.user.id);

async function edit(user: AdminUserDto): Promise<void> {
  editing.value = user;
  editName.value = user.name;
  history.value = [];
  history.value = await api<AuditLogDto[]>(`/admin/users/${user.id}/history`).catch(() => []);
}

/** Applies a change from the panel and refreshes the table, the history and, for oneself, the session user. */
async function apply(request: () => Promise<AdminUserDto>, success?: string): Promise<void> {
  const current = editing.value;
  if (!current) return;
  try {
    editing.value = await request();
    if (success) toast.add({ title: success, icon: 'i-lucide-check' });
  } catch (e) {
    notifyError(e);
  }
  if (current.id === me.value?.user.id) {
    await fetchMe();
    // Took the superadmin flag from oneself: this page is closed now.
    if (!me.value?.user.isSuperadmin) {
      await navigateTo('/');
      return;
    }
  }
  await refresh();
  history.value = await api<AuditLogDto[]>(`/admin/users/${current.id}/history`).catch(() => history.value);
}

const patchUser = (body: object) => api<AdminUserDto>(`/admin/users/${editing.value!.id}`, { method: 'PATCH', body });

function saveName(): Promise<void> {
  return apply(() => patchUser({ name: editName.value }), t('users.saved'));
}

function setSuperadmin(value: boolean): Promise<void> {
  return apply(() => patchUser({ isSuperadmin: value }));
}

function setDisabled(disabled: boolean): Promise<void> {
  const name = editing.value!.name;
  return apply(() => patchUser({ disabled }), disabled ? t('users.disabledToast', { name }) : t('users.enabledToast', { name }));
}

function accessOf(user: AdminUserDto, workspaceId: string): Access {
  return user.memberships.find((m) => m.workspaceId === workspaceId)?.role ?? NO_ACCESS;
}

function setAccess(workspaceId: string, access: Access): Promise<void> {
  const base = `/admin/users/${editing.value!.id}/memberships/${workspaceId}`;
  return apply(() =>
    access === NO_ACCESS ? api<AdminUserDto>(base, { method: 'DELETE' }) : api<AdminUserDto>(base, { method: 'PUT', body: { role: access } }),
  );
}

async function issueLink(): Promise<void> {
  const user = editing.value;
  if (!user) return;
  try {
    showLink(await api<PasswordLinkDto>(`/admin/users/${user.id}/password-link`, { method: 'POST' }), user.name);
    history.value = await api<AuditLogDto[]>(`/admin/users/${user.id}/history`).catch(() => history.value);
  } catch (e) {
    notifyError(e);
  }
}

const workspaceNames = computed(() => new Map(workspaces.value.map((w) => [w.id, w.name])));

function historyActor(entry: AuditLogDto): string {
  return entry.actor.type === 'system' ? t('audit.system') : (entry.actor.name ?? t('common.none'));
}

/** What changed: the fields that differ, the role of a membership, the kind of a password link. */
function historyChanges(entry: AuditLogDto): string {
  const before = entry.before ?? {};
  const after = entry.after ?? {};
  if (entry.action === 'password_link') {
    return after.purpose === 'reset' ? t('passwordLink.resetTitle') : t('passwordLink.inviteTitle');
  }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => key !== 'createdAt' && key !== 'userId' && JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
  if (entry.action === 'create' || entry.action === 'delete') {
    const view = entry.action === 'create' ? after : before;
    return typeof view.role === 'string' ? t(`members.role.${view.role as WorkspaceRole}`) : '';
  }
  return keys.map((key) => `${key}: ${String(before[key] ?? '—')} → ${String(after[key] ?? '—')}`).join(', ');
}
</script>

<template>
  <UDashboardPanel id="admin-users">
    <template #header>
      <UDashboardNavbar :title="t('nav.users')">
        <template #right>
          <UButton icon="i-lucide-user-plus" :label="t('users.new')" @click="startCreate" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <p class="mb-4 max-w-2xl text-sm text-(--ui-text-muted)">{{ t('users.intro') }}</p>
      <UTable :data="users" :columns="columns" :loading="status === 'pending'">
        <template #name-cell="{ row }">
          <p class="font-medium">{{ row.original.name }}</p>
          <p class="text-sm text-(--ui-text-muted)">{{ row.original.email }}</p>
        </template>
        <template #status-cell="{ row }">
          <div class="flex flex-wrap gap-1">
            <UBadge :color="USER_STATUS_COLORS[row.original.status]" variant="subtle">{{ userStatusLabel(row.original.status) }}</UBadge>
            <UBadge v-if="row.original.isSuperadmin" color="primary" variant="subtle">{{ t('users.superadmin') }}</UBadge>
          </div>
        </template>
        <template #access-cell="{ row }">
          <div class="flex flex-wrap gap-1">
            <UBadge v-for="m in row.original.memberships" :key="m.workspaceId" color="neutral" variant="outline">
              {{ m.workspaceName }} · {{ t(`members.role.${m.role}`) }}
            </UBadge>
            <span v-if="row.original.memberships.length === 0" class="text-sm text-(--ui-text-muted)">{{ t('common.none') }}</span>
          </div>
        </template>
        <template #lastSeenAt-cell="{ row }">
          {{ row.original.lastSeenAt ? formatRelative(row.original.lastSeenAt) : t('users.never') }}
        </template>
        <template #actions-cell="{ row }">
          <UButton icon="i-lucide-pencil" color="neutral" variant="ghost" :aria-label="t('common.edit')" @click="edit(row.original)" />
        </template>
      </UTable>

      <UModal v-model:open="createOpen" :title="t('users.new')" :description="t('users.newHint')">
        <template #body>
          <form id="user-form" class="space-y-4" @submit.prevent="create">
            <UFormField label="Email" required>
              <UInput v-model="createState.email" type="email" class="w-full" autofocus />
            </UFormField>
            <UFormField :label="t('members.name')" required>
              <UInput v-model="createState.name" class="w-full" />
            </UFormField>
            <USwitch v-model="createState.isSuperadmin" :label="t('users.superadmin')" :description="t('users.superadminHelp')" />
            <div class="space-y-2">
              <p class="text-sm font-medium">{{ t('users.access') }}</p>
              <p v-if="createState.isSuperadmin" class="text-sm text-(--ui-text-muted)">{{ t('users.superadminAccess') }}</p>
              <div v-for="w in workspaces" :key="w.id" class="flex items-center justify-between gap-4">
                <span class="truncate text-sm">{{ w.name }}</span>
                <USelect
                  :model-value="createState.access[w.id] ?? NO_ACCESS"
                  :items="accessItems"
                  class="w-44"
                  @update:model-value="(value) => (createState.access[w.id] = value as Access)"
                />
              </div>
            </div>
            <UAlert v-if="createError" color="error" variant="subtle" :title="createError" />
          </form>
        </template>
        <template #footer>
          <UButton color="neutral" variant="ghost" @click="createOpen = false">{{ t('common.cancel') }}</UButton>
          <UButton type="submit" form="user-form" :disabled="!createState.email || !createState.name.trim()">{{ t('users.invite') }}</UButton>
        </template>
      </UModal>

      <USlideover :open="editing !== null" :title="editing?.name" :description="editing?.email" @update:open="(open: boolean) => !open && (editing = null)">
        <template #body>
          <div v-if="editing" class="space-y-6">
            <div class="flex flex-wrap items-center gap-2">
              <UBadge :color="USER_STATUS_COLORS[editing.status]" variant="subtle">{{ userStatusLabel(editing.status) }}</UBadge>
              <span class="text-sm text-(--ui-text-muted)">
                {{ t('users.lastSeen') }}: {{ editing.lastSeenAt ? formatRelative(editing.lastSeenAt) : t('users.never') }}
              </span>
            </div>

            <form class="flex items-end gap-2" @submit.prevent="saveName">
              <UFormField :label="t('members.name')" class="flex-1">
                <UInput v-model="editName" class="w-full" />
              </UFormField>
              <UButton type="submit" color="neutral" variant="soft" :disabled="!editName.trim() || editName.trim() === editing.name">
                {{ t('common.save') }}
              </UButton>
            </form>

            <USwitch
              :model-value="editing.isSuperadmin"
              :label="t('users.superadmin')"
              :description="t('users.superadminHelp')"
              @update:model-value="setSuperadmin"
            />

            <section class="space-y-2">
              <h3 class="text-sm font-medium">{{ t('users.access') }}</h3>
              <p v-if="editing.isSuperadmin" class="text-sm text-(--ui-text-muted)">{{ t('users.superadminAccess') }}</p>
              <div v-for="w in workspaces" :key="w.id" class="flex items-center justify-between gap-4">
                <span class="truncate text-sm">{{ w.name }}</span>
                <USelect
                  :model-value="accessOf(editing, w.id)"
                  :items="accessItems"
                  class="w-44"
                  @update:model-value="(value) => setAccess(w.id, value as Access)"
                />
              </div>
            </section>

            <section class="flex flex-wrap gap-2">
              <UButton v-if="editing.status !== 'disabled'" icon="i-lucide-link" color="neutral" variant="soft" @click="issueLink">
                {{ editing.status === 'invited' ? t('users.inviteLink') : t('users.resetLink') }}
              </UButton>
              <UButton v-if="editing.status === 'disabled'" icon="i-lucide-user-check" color="neutral" variant="soft" @click="setDisabled(false)">
                {{ t('common.enable') }}
              </UButton>
              <UButton v-else-if="!isSelf" icon="i-lucide-user-x" color="error" variant="soft" @click="setDisabled(true)">
                {{ t('common.disable') }}
              </UButton>
            </section>
            <p v-if="editing.status !== 'disabled' && !isSelf" class="text-sm text-(--ui-text-muted)">{{ t('users.disableHint') }}</p>

            <section class="space-y-2">
              <h3 class="text-sm font-medium">{{ t('users.history') }}</h3>
              <p v-if="history.length === 0" class="text-sm text-(--ui-text-muted)">{{ t('audit.empty') }}</p>
              <ul class="space-y-2 text-sm">
                <li v-for="entry in history" :key="entry.id">
                  <p>
                    <span class="font-medium">{{ t(`audit.entity.${entry.entity}`) }}: {{ t(`audit.action.${entry.action}`) }}</span>
                    <span v-if="entry.entity === 'member'" class="text-(--ui-text-muted)"> · {{ workspaceNames.get(entry.workspaceId ?? '') ?? '—' }}</span>
                    <span v-if="historyChanges(entry)" class="text-(--ui-text-muted)"> · {{ historyChanges(entry) }}</span>
                  </p>
                  <p class="text-xs text-(--ui-text-muted)">{{ formatDateTime(entry.createdAt) }} · {{ historyActor(entry) }}</p>
                </li>
              </ul>
            </section>
          </div>
        </template>
      </USlideover>

      <PasswordLinkModal :link="link" :name="linkName" @close="link = null" />
    </template>
  </UDashboardPanel>
</template>
