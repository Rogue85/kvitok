<script setup lang="ts">
import { AddMemberSchema, WORKSPACE_ROLES, type AddMemberInput, type MemberDto, type WorkspaceRole } from '@kvitok/shared';
import type { FormSubmitEvent, TableColumn } from '@nuxt/ui';

const roleLabel = (role: WorkspaceRole) => t(`members.role.${role}`);
const roleItems = WORKSPACE_ROLES.map((value) => ({ label: roleLabel(value), value }));

const toast = useToast();
const { me } = useAuth();
const { workspaceId, can } = useWorkspace();
const isAdmin = computed(() => can('admin'));

const { data: members, refresh, status } = await useAsyncData(
  () => `members:${workspaceId.value}`,
  () => api<MemberDto[]>(`/workspaces/${workspaceId.value}/members`),
  { watch: [workspaceId], default: () => [] },
);

const columns: TableColumn<MemberDto>[] = [
  { accessorKey: 'name', header: t('members.name') },
  { accessorKey: 'email', header: 'Email' },
  { accessorKey: 'role', header: t('members.roleColumn') },
  { id: 'actions', header: '' },
];

function notifyError(error: unknown): void {
  toast.add({ color: 'error', title: error instanceof ApiError ? error.message : t('common.error') });
}

async function changeRole(member: MemberDto, role: WorkspaceRole): Promise<void> {
  try {
    await api(`/workspaces/${workspaceId.value}/members/${member.userId}`, { method: 'PATCH', body: { role } });
    toast.add({ color: 'success', title: `${member.name}: ${roleLabel(role)}` });
  } catch (error) {
    notifyError(error);
  }
  await refresh();
}

async function remove(member: MemberDto): Promise<void> {
  try {
    await api(`/workspaces/${workspaceId.value}/members/${member.userId}`, { method: 'DELETE' });
    toast.add({ color: 'success', title: t('members.removed', { name: member.name }) });
    await refresh();
  } catch (error) {
    notifyError(error);
  }
}

const addOpen = ref(false);
const addState = reactive<{ email: string; role: WorkspaceRole; name?: string; password?: string }>({
  email: '',
  role: 'operator',
});
const addError = ref<string | null>(null);

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

async function onAdd(event: FormSubmitEvent<AddMemberInput>): Promise<void> {
  addError.value = null;
  try {
    await api(`/workspaces/${workspaceId.value}/members`, { method: 'POST', body: event.data });
    addOpen.value = false;
    Object.assign(addState, { email: '', role: 'operator', name: undefined, password: undefined });
    await refresh();
  } catch (error) {
    addError.value = error instanceof ApiError ? error.message : t('members.addFailed');
  }
}
</script>

<template>
  <UDashboardPanel id="members">
    <template #header>
      <UDashboardNavbar :title="t('nav.members')">
        <template #right>
          <UButton v-if="isAdmin" icon="i-lucide-user-plus" :label="t('common.add')" @click="addOpen = true" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UTable :data="members" :columns="columns" :loading="status === 'pending'">
        <template #role-cell="{ row }">
          <USelect
            v-if="isAdmin && row.original.userId !== me?.user.id"
            :model-value="row.original.role"
            :items="roleItems"
            class="w-44"
            @update:model-value="(role) => changeRole(row.original, role as WorkspaceRole)"
          />
          <UBadge v-else variant="subtle" color="neutral">{{ roleLabel(row.original.role) }}</UBadge>
        </template>
        <template #actions-cell="{ row }">
          <UButton
            v-if="isAdmin && row.original.userId !== me?.user.id"
            icon="i-lucide-trash-2"
            color="error"
            variant="ghost"
            :aria-label="t('common.delete')"
            @click="remove(row.original)"
          />
        </template>
      </UTable>

      <UModal v-model:open="addOpen" :title="t('members.new')">
        <template #body>
          <UForm
            id="add-member"
            :schema="AddMemberSchema"
            :state="{ ...addState, name: emptyToUndefined(addState.name), password: emptyToUndefined(addState.password) }"
            class="space-y-4"
            @submit="onAdd"
          >
            <UFormField label="Email" name="email">
              <UInput v-model="addState.email" type="email" class="w-full" />
            </UFormField>
            <UFormField :label="t('members.roleColumn')" name="role">
              <USelect v-model="addState.role" :items="roleItems" class="w-full" />
            </UFormField>
            <p class="text-sm text-(--ui-text-muted)">{{ t('members.newUserHint') }}</p>
            <UFormField :label="t('members.name')" name="name">
              <UInput v-model="addState.name" class="w-full" />
            </UFormField>
            <UFormField :label="t('auth.password')" name="password">
              <UInput v-model="addState.password" type="password" autocomplete="new-password" class="w-full" />
            </UFormField>
            <UAlert v-if="addError" color="error" variant="subtle" :title="addError" />
          </UForm>
        </template>
        <template #footer>
          <UButton color="neutral" variant="ghost" @click="addOpen = false">{{ t('common.cancel') }}</UButton>
          <UButton type="submit" form="add-member">{{ t('common.add') }}</UButton>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
