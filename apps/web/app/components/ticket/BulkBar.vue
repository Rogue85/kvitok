<script setup lang="ts">
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type BulkUpdateTicketsInput,
  type BulkUpdateTicketsResultDto,
} from '@kvitok/shared';
import type { DropdownMenuItem } from '@nuxt/ui';

/** Tickets by id, or every ticket of the list filter (its API parameters). */
export type BulkTarget = { ids: string[] } | { filter: Record<string, string> };

const props = defineProps<{ count: number; target: BulkTarget; tags: string[] }>();
const emit = defineEmits<{ done: [result: BulkUpdateTicketsResultDto]; clear: [] }>();

const toast = useToast();
const { workspaceId, canSee } = useWorkspace();
const { me } = useAuth();
const { departments, members } = useWorkspaceData();

type Changes = BulkUpdateTicketsInput['changes'];
const busy = ref(false);
const confirming = ref<Changes | null>(null);

/** A move to a department the user cannot see: they lose the tickets. */
function leaves(changes: Changes): boolean {
  return changes.departmentId !== undefined && !canSee(changes.departmentId);
}

/**
 * A change of every ticket by the filter is confirmed first: the selection is not on the screen.
 * So is a move to a department the user cannot see.
 */
function request(changes: Changes): void {
  if ('filter' in props.target || leaves(changes)) {
    confirming.value = changes;
  } else {
    void apply(changes);
  }
}

async function apply(changes: Changes): Promise<void> {
  confirming.value = null;
  busy.value = true;
  try {
    const result = await api<BulkUpdateTicketsResultDto>(`/workspaces/${workspaceId.value}/tickets/bulk`, {
      method: 'POST',
      body: { ...props.target, changes },
    });
    if (result.failed.length === 0) {
      toast.add({ title: t('tickets.bulk.done', { count: result.updated.length }), icon: 'i-lucide-check' });
    } else {
      const shown = result.failed.slice(0, 3).map((f) => `T-${f.number}: ${f.message}`);
      if (result.failed.length > shown.length) shown.push(t('tickets.bulk.more', { count: result.failed.length - shown.length }));
      toast.add({
        color: 'warning',
        title: t('tickets.bulk.partlyDone', { updated: result.updated.length, total: result.updated.length + result.failed.length }),
        description: shown.join('\n'),
        duration: 10_000,
      });
    }
    emit('done', result);
  } catch (error) {
    toast.add({ color: 'error', title: toApiError(error).message });
  } finally {
    busy.value = false;
  }
}

const statusItems = computed<DropdownMenuItem[]>(() =>
  TICKET_STATUSES.map((status) => ({ label: statusLabel(status), onSelect: () => request({ status }) })),
);
const priorityItems = computed<DropdownMenuItem[]>(() =>
  TICKET_PRIORITIES.map((priority) => ({ label: priorityLabel(priority), onSelect: () => request({ priority }) })),
);

const assigneeOpen = ref(false);
const assigneeItems = computed(() => [
  ...(me.value ? [{ label: t('tickets.bulk.assignToMe'), id: me.value.user.id, icon: 'i-lucide-user-check' }] : []),
  { label: t('tickets.bulk.unassign'), id: null, icon: 'i-lucide-user-x' },
  ...members.data.value
    .filter((m) => m.role !== 'viewer' && m.status !== 'disabled')
    .map((m) => ({ label: m.name, suffix: m.email, id: m.userId })),
].map(({ id, ...item }) => ({ ...item, onSelect: () => assign(id) })));
function assign(assigneeId: string | null): void {
  assigneeOpen.value = false;
  request({ assigneeId });
}

const departmentOpen = ref(false);
// Handing tickets over to a department the user cannot see is allowed; it is marked, as they lose those tickets.
const departmentItems = computed(() => [
  { label: t('tickets.filters.noDepartment'), id: null },
  ...departments.data.value.filter((d) => !d.archived).map((d) => ({ label: d.title, id: d.id })),
].map(({ id, ...item }) => ({ ...item, ...(canSee(id) ? {} : { suffix: t('ticket.departmentNoAccess') }), onSelect: () => moveTo(id) })));
function departmentTitle(departmentId: string | null): string {
  return departmentId ? (departments.data.value.find((d) => d.id === departmentId)?.title ?? '—') : t('tickets.filters.noDepartment');
}
function moveTo(departmentId: string | null): void {
  departmentOpen.value = false;
  request({ departmentId });
}

const tagsOpen = ref(false);
const addTags = ref<string[]>([]);
const removeTags = ref<string[]>([]);
watch(tagsOpen, () => {
  addTags.value = [];
  removeTags.value = [];
});
function changeTags(): void {
  tagsOpen.value = false;
  request({
    ...(addTags.value.length ? { addTags: addTags.value } : {}),
    ...(removeTags.value.length ? { removeTags: removeTags.value } : {}),
  });
}
</script>

<template>
  <div class="flex items-center gap-1 rounded-lg border border-(--ui-border) bg-(--ui-bg) p-1.5 shadow-lg">
    <span class="px-2 text-sm font-medium whitespace-nowrap">{{ tp('tickets.bulk.selected', count) }}</span>
    <USeparator orientation="vertical" class="h-5" />

    <UDropdownMenu :items="statusItems" :content="{ side: 'top' }">
      <UButton color="neutral" variant="ghost" icon="i-lucide-circle-dot" :label="t('tickets.columns.status')" :disabled="busy" />
    </UDropdownMenu>

    <UPopover v-model:open="assigneeOpen" :content="{ side: 'top' }">
      <UButton color="neutral" variant="ghost" icon="i-lucide-user" :label="t('tickets.columns.assignee')" :disabled="busy" />
      <template #content>
        <UCommandPalette :groups="[{ id: 'assignee', items: assigneeItems }]" :placeholder="t('common.search')" class="max-h-80 w-72" />
      </template>
    </UPopover>

    <UDropdownMenu :items="priorityItems" :content="{ side: 'top' }">
      <UButton color="neutral" variant="ghost" icon="i-lucide-signal" :label="t('tickets.filters.priority')" :disabled="busy" />
    </UDropdownMenu>

    <UPopover v-model:open="departmentOpen" :content="{ side: 'top' }">
      <UButton color="neutral" variant="ghost" icon="i-lucide-building-2" :label="t('tickets.columns.department')" :disabled="busy" />
      <template #content>
        <UCommandPalette :groups="[{ id: 'department', items: departmentItems }]" :placeholder="t('common.search')" class="max-h-80 w-64" />
      </template>
    </UPopover>

    <UPopover v-model:open="tagsOpen" :content="{ side: 'top' }">
      <UButton color="neutral" variant="ghost" icon="i-lucide-tag" :label="t('tickets.filters.tags')" :disabled="busy" />
      <template #content>
        <div class="flex w-72 flex-col gap-3 p-3">
          <UFormField :label="t('tickets.bulk.addTags')" size="sm">
            <UInputTags v-model="addTags" class="w-full" />
          </UFormField>
          <UFormField :label="t('tickets.bulk.removeTags')" size="sm">
            <USelectMenu v-model="removeTags" :items="tags" multiple class="w-full" />
          </UFormField>
          <UButton :label="t('tickets.filters.apply')" block :disabled="!addTags.length && !removeTags.length" @click="changeTags" />
        </div>
      </template>
    </UPopover>

    <USeparator orientation="vertical" class="h-5" />
    <UButton color="neutral" variant="ghost" icon="i-lucide-x" :aria-label="t('tickets.bulk.clear')" :loading="busy" @click="emit('clear')" />

    <UModal :open="confirming !== null" :title="t('tickets.bulk.confirmTitle')" @update:open="(v: boolean) => !v && (confirming = null)">
      <template #body>
        <div class="space-y-2 text-sm">
          <p v-if="'filter' in target">{{ t('tickets.bulk.confirmText', { count }) }}</p>
          <p v-if="confirming && leaves(confirming)">{{ t('tickets.bulk.moveOut', { department: departmentTitle(confirming.departmentId ?? null) }) }}</p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" :label="t('common.cancel')" @click="confirming = null" />
          <UButton :label="t('tickets.bulk.confirm')" @click="confirming && apply(confirming)" />
        </div>
      </template>
    </UModal>
  </div>
</template>
