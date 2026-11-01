<script setup lang="ts">
import {
  WORKSPACE_ROLES,
  type AddMemberResult,
  type MemberCandidateDto,
  type MemberDepartmentsInput,
  type MemberDto,
  type PasswordLinkDto,
  type WorkspaceRole,
} from '@kvitok/shared';
import type { TableColumn } from '@nuxt/ui';

const roleLabel = (role: WorkspaceRole) => t(`members.role.${role}`);
const roleItems = WORKSPACE_ROLES.map((value) => ({ label: roleLabel(value), value }));

const toast = useToast();
const { me } = useAuth();
const { workspaceId, can } = useWorkspace();
const isAdmin = computed(() => can('admin'));
const { departments, departmentById } = useWorkspaceData();

const { data: members, refresh, status } = await useAsyncData(
  () => `members:${workspaceId.value}`,
  () => api<MemberDto[]>(`/workspaces/${workspaceId.value}/members`),
  { watch: [workspaceId], default: () => [] },
);

const columns: TableColumn<MemberDto>[] = [
  { accessorKey: 'name', header: t('members.name') },
  { accessorKey: 'email', header: 'Email' },
  { accessorKey: 'role', header: t('members.roleColumn') },
  { id: 'departments', header: t('members.departments') },
  { id: 'actions', header: '' },
];

/** The member's departments in a cell: every one, a few titles or how many. */
function departmentsLabel(member: MemberDto): string {
  if (member.role === 'admin' || member.departments.allDepartments) return t('members.allDepartments');
  const titles = member.departments.departmentIds.map((id) => departmentById.value.get(id)?.title ?? '—');
  return titles.length > 0 && titles.length <= 3 ? titles.join(', ') : tp('members.departmentCount', titles.length);
}

const ALL: MemberDepartmentsInput = { allDepartments: true, departmentIds: [] };
const editingDepartments = ref<MemberDto | null>(null);
const departmentsDraft = ref<MemberDepartmentsInput>(ALL);

function editDepartments(member: MemberDto): void {
  departmentsDraft.value = { ...member.departments };
  editingDepartments.value = member;
}

async function saveDepartments(): Promise<void> {
  const member = editingDepartments.value!;
  try {
    await api(`/workspaces/${workspaceId.value}/members/${member.userId}`, { method: 'PATCH', body: { departments: departmentsDraft.value } });
    toast.add({ color: 'success', title: t('members.departmentsSaved', { name: member.name }) });
    editingDepartments.value = null;
  } catch (error) {
    notifyError(error);
  }
  await refresh();
}

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

const link = ref<PasswordLinkDto | null>(null);
const linkName = ref('');

async function inviteLink(member: MemberDto): Promise<void> {
  try {
    link.value = await api<PasswordLinkDto>(`/workspaces/${workspaceId.value}/members/${member.userId}/invite-link`, { method: 'POST' });
    linkName.value = member.name;
  } catch (error) {
    notifyError(error);
  }
}

// Adding: an existing user of the installation, or an invitation for a new person.
type AddMode = 'existing' | 'invite';
const addOpen = ref(false);
const addMode = ref<AddMode>('existing');
const modeItems = [
  { label: t('members.existing'), value: 'existing' },
  { label: t('members.inviteNew'), value: 'invite' },
];
const addState = reactive<{ userId: string | undefined; email: string; name: string; role: WorkspaceRole; departments: MemberDepartmentsInput }>({
  userId: undefined,
  email: '',
  name: '',
  role: 'operator',
  departments: ALL,
});
const addError = ref<string | null>(null);
const candidates = ref<MemberCandidateDto[]>([]);
const candidateItems = computed(() =>
  candidates.value.map((c) => ({
    label: c.name,
    description: c.status === 'invited' ? `${c.email} · ${userStatusLabel(c.status)}` : c.email,
    value: c.id,
  })),
);

async function startAdd(): Promise<void> {
  Object.assign(addState, { userId: undefined, email: '', name: '', role: 'operator', departments: ALL });
  addError.value = null;
  try {
    candidates.value = await api<MemberCandidateDto[]>(`/workspaces/${workspaceId.value}/members/candidates`);
  } catch (error) {
    notifyError(error);
    return;
  }
  addMode.value = candidates.value.length > 0 ? 'existing' : 'invite';
  addOpen.value = true;
}

const canAdd = computed(() =>
  addMode.value === 'existing' ? addState.userId !== undefined : addState.email.trim() !== '' && addState.name.trim() !== '',
);

async function onAdd(): Promise<void> {
  addError.value = null;
  // Administrators always have every department.
  const access = { role: addState.role, ...(addState.role === 'admin' ? {} : { departments: addState.departments }) };
  const body =
    addMode.value === 'existing' ? { userId: addState.userId, ...access } : { email: addState.email, name: addState.name, ...access };
  try {
    const result = await api<AddMemberResult>(`/workspaces/${workspaceId.value}/members`, { method: 'POST', body });
    addOpen.value = false;
    if (result.link) {
      link.value = result.link;
      linkName.value = result.member.name;
    }
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
          <UButton v-if="isAdmin" icon="i-lucide-user-plus" :label="t('common.add')" @click="startAdd" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UTable :data="members" :columns="columns" :loading="status === 'pending'">
        <template #name-cell="{ row }">
          <div class="flex items-center gap-2">
            <span :class="{ 'text-(--ui-text-muted)': row.original.status === 'disabled' }">{{ row.original.name }}</span>
            <UBadge v-if="row.original.status !== 'active'" :color="USER_STATUS_COLORS[row.original.status]" variant="subtle">
              {{ userStatusLabel(row.original.status) }}
            </UBadge>
          </div>
        </template>
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
        <template #departments-cell="{ row }">
          <UButton
            v-if="isAdmin && row.original.role !== 'admin'"
            :label="departmentsLabel(row.original)"
            color="neutral"
            variant="ghost"
            trailing-icon="i-lucide-pencil"
            :aria-label="t('members.editDepartments')"
            @click="editDepartments(row.original)"
          />
          <span v-else class="text-sm" :class="{ 'text-(--ui-text-muted)': row.original.role === 'admin' }">{{ departmentsLabel(row.original) }}</span>
        </template>
        <template #actions-cell="{ row }">
          <div v-if="isAdmin && row.original.userId !== me?.user.id" class="flex justify-end gap-1">
            <UButton
              v-if="row.original.status === 'invited'"
              icon="i-lucide-link"
              color="neutral"
              variant="ghost"
              :aria-label="t('users.inviteLink')"
              @click="inviteLink(row.original)"
            />
            <UButton icon="i-lucide-trash-2" color="error" variant="ghost" :aria-label="t('common.delete')" @click="remove(row.original)" />
          </div>
        </template>
      </UTable>

      <UModal v-model:open="addOpen" :title="t('members.new')">
        <template #body>
          <form id="add-member" class="space-y-4" @submit.prevent="onAdd">
            <UTabs v-model="addMode" :items="modeItems" :content="false" class="w-full" />
            <template v-if="addMode === 'existing'">
              <UFormField :label="t('members.user')">
                <USelectMenu
                  v-model="addState.userId"
                  :items="candidateItems"
                  value-key="value"
                  :placeholder="t('members.chooseUser')"
                  class="w-full"
                />
              </UFormField>
              <p v-if="candidates.length === 0" class="text-sm text-(--ui-text-muted)">{{ t('members.noCandidates') }}</p>
            </template>
            <template v-else>
              <UFormField label="Email" required>
                <UInput v-model="addState.email" type="email" class="w-full" />
              </UFormField>
              <UFormField :label="t('members.name')" required>
                <UInput v-model="addState.name" class="w-full" />
              </UFormField>
              <p class="text-sm text-(--ui-text-muted)">{{ t('members.inviteHint') }}</p>
            </template>
            <UFormField :label="t('members.roleColumn')">
              <USelect v-model="addState.role" :items="roleItems" class="w-full" />
            </UFormField>
            <UFormField v-if="addState.role !== 'admin'" :label="t('members.departments')">
              <MembersDepartmentsField v-model="addState.departments" :departments="departments.data.value" :workspace-id="workspaceId" />
            </UFormField>
            <UAlert v-if="addError" color="error" variant="subtle" :title="addError" />
          </form>
        </template>
        <template #footer>
          <UButton color="neutral" variant="ghost" @click="addOpen = false">{{ t('common.cancel') }}</UButton>
          <UButton type="submit" form="add-member" :disabled="!canAdd">
            {{ addMode === 'existing' ? t('common.add') : t('users.invite') }}
          </UButton>
        </template>
      </UModal>

      <UModal
        :open="editingDepartments !== null"
        :title="t('members.departmentsTitle', { name: editingDepartments?.name ?? '' })"
        @update:open="(open: boolean) => !open && (editingDepartments = null)"
      >
        <template #body>
          <MembersDepartmentsField
            v-if="editingDepartments"
            v-model="departmentsDraft"
            :departments="departments.data.value"
            :workspace-id="workspaceId"
            :member="{ userId: editingDepartments.userId, name: editingDepartments.name }"
          />
        </template>
        <template #footer>
          <UButton color="neutral" variant="ghost" @click="editingDepartments = null">{{ t('common.cancel') }}</UButton>
          <UButton @click="saveDepartments">{{ t('common.save') }}</UButton>
        </template>
      </UModal>

      <PasswordLinkModal :link="link" :name="linkName" @close="link = null" />
    </template>
  </UDashboardPanel>
</template>
