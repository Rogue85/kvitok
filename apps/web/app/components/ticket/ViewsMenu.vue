<script setup lang="ts">
import type { TicketViewDto } from '@kvitok/shared';
import type { DropdownMenuItem } from '@nuxt/ui';

/** The queue's current state as a saved view keeps it. */
const props = defineProps<{ query: Record<string, string> }>();
/** The view the queue was opened from; it stays active while the filters change. */
const activeId = defineModel<string | null>('activeId', { required: true });
const emit = defineEmits<{ apply: [view: TicketViewDto] }>();

const toast = useToast();
const { workspaceId, can } = useWorkspace();
const url = computed(() => `/workspaces/${workspaceId.value}/ticket-views`);

const { data: views, refresh } = await useAsyncData(
  () => `ticket-views:${workspaceId.value}`,
  () => api<TicketViewDto[]>(url.value),
  { default: () => [] },
);

const active = computed(() => views.value.find((v) => v.id === activeId.value) ?? null);
const modified = computed(() => active.value !== null && !sameQuery(active.value.query, props.query));

function sameQuery(a: Record<string, string>, b: Record<string, string>): boolean {
  const normal = (q: Record<string, string>) => JSON.stringify(Object.entries(q).sort(([x], [y]) => x.localeCompare(y)));
  return normal(a) === normal(b);
}

async function run<T>(action: () => Promise<T>, success: string): Promise<T | null> {
  try {
    const result = await action();
    toast.add({ title: success, icon: 'i-lucide-check' });
    await refresh();
    return result;
  } catch (error) {
    toast.add({ color: 'error', title: toApiError(error).message });
    return null;
  }
}

const items = computed<DropdownMenuItem[][]>(() => {
  const list: DropdownMenuItem[] = views.value.map((view) => ({
    label: view.name,
    icon: view.shared ? 'i-lucide-users' : 'i-lucide-bookmark',
    trailingIcon: view.id === activeId.value ? 'i-lucide-check' : undefined,
    onSelect: () => emit('apply', view),
  }));
  const actions: DropdownMenuItem[] = [
    ...(active.value && modified.value && active.value.editable
      ? [{ label: t('tickets.presets.saveChanges', { name: active.value.name }), icon: 'i-lucide-save', onSelect: () => void saveChanges() }]
      : []),
    { label: t('tickets.presets.saveAs'), icon: 'i-lucide-bookmark-plus', onSelect: () => openSaveAs() },
    ...(views.value.length ? [{ label: t('tickets.presets.manage'), icon: 'i-lucide-settings-2', onSelect: () => (manageOpen.value = true) }] : []),
  ];
  return [list.length ? list : [{ label: t('tickets.presets.empty'), disabled: true }], actions];
});

async function saveChanges(): Promise<void> {
  const view = active.value;
  if (!view) return;
  await run(() => api(`${url.value}/${view.id}`, { method: 'PATCH', body: { query: props.query } }), t('tickets.presets.saved'));
}

/* Saving as a new view */

const saveOpen = ref(false);
const saveName = ref('');
const saveShared = ref(false);
function openSaveAs(): void {
  saveName.value = '';
  saveShared.value = false;
  saveOpen.value = true;
}
async function saveAs(): Promise<void> {
  const view = await run(
    () => api<TicketViewDto>(url.value, { method: 'POST', body: { name: saveName.value, shared: saveShared.value, query: props.query } }),
    t('tickets.presets.saved'),
  );
  if (view) {
    saveOpen.value = false;
    activeId.value = view.id;
  }
}

/* Managing: rename and delete without opening a view */

const manageOpen = ref(false);
const editing = ref<{ id: string; name: string } | null>(null);
const deleting = ref<string | null>(null);
watch(manageOpen, () => {
  editing.value = null;
  deleting.value = null;
});
async function rename(): Promise<void> {
  const edit = editing.value;
  if (!edit) return;
  const done = await run(() => api(`${url.value}/${edit.id}`, { method: 'PATCH', body: { name: edit.name } }), t('tickets.presets.saved'));
  if (done !== null) editing.value = null;
}
async function remove(id: string): Promise<void> {
  const done = await run(() => api(`${url.value}/${id}`, { method: 'DELETE' }), t('tickets.presets.deleted'));
  if (done !== null && activeId.value === id) activeId.value = null;
  deleting.value = null;
}
</script>

<template>
  <UDropdownMenu :items="items" :content="{ align: 'start' }" :ui="{ content: 'min-w-64' }">
    <UButton color="neutral" variant="ghost" size="sm" :icon="active?.shared ? 'i-lucide-users' : 'i-lucide-bookmark'" trailing-icon="i-lucide-chevron-down">
      <span class="max-w-48 truncate">{{ active?.name ?? t('tickets.presets.title') }}</span>
      <span v-if="modified" class="text-(--ui-text-muted)">· {{ t('tickets.presets.modified') }}</span>
    </UButton>
  </UDropdownMenu>

  <UModal v-model:open="saveOpen" :title="t('tickets.presets.saveAsTitle')">
    <template #body>
      <form id="save-view" class="flex flex-col gap-4" @submit.prevent="saveAs">
        <UFormField :label="t('common.name')">
          <UInput v-model="saveName" autofocus maxlength="100" class="w-full" :placeholder="t('tickets.presets.namePlaceholder')" />
        </UFormField>
        <UCheckbox
          v-if="can('admin')"
          v-model="saveShared"
          :label="t('tickets.presets.shared')"
          :description="t('tickets.presets.sharedHint')"
        />
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" :label="t('common.cancel')" @click="saveOpen = false" />
        <UButton type="submit" form="save-view" :label="t('common.save')" :disabled="!saveName.trim()" />
      </div>
    </template>
  </UModal>

  <UModal v-model:open="manageOpen" :title="t('tickets.presets.manageTitle')">
    <template #body>
      <p v-if="!views.length" class="text-sm text-(--ui-text-muted)">{{ t('tickets.presets.empty') }}</p>
      <ul class="divide-y divide-(--ui-border)">
        <li v-for="view in views" :key="view.id" class="flex min-h-12 items-center gap-2 py-2">
          <UIcon :name="view.shared ? 'i-lucide-users' : 'i-lucide-bookmark'" class="size-4 shrink-0 text-(--ui-text-muted)" />
          <form v-if="editing?.id === view.id" class="flex flex-1 gap-2" @submit.prevent="rename">
            <UInput v-model="editing.name" size="sm" autofocus maxlength="100" class="flex-1" />
            <UButton type="submit" size="sm" :label="t('common.save')" :disabled="!editing.name.trim()" />
            <UButton size="sm" color="neutral" variant="ghost" :label="t('common.cancel')" @click="editing = null" />
          </form>
          <template v-else>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm">{{ view.name }}</p>
              <p v-if="view.shared" class="truncate text-xs text-(--ui-text-muted)">
                {{ t('tickets.presets.sharedBy', { name: view.author?.name ?? '—' }) }}
              </p>
            </div>
            <template v-if="view.editable">
              <template v-if="deleting === view.id">
                <UButton size="sm" color="error" :label="t('common.delete')" @click="remove(view.id)" />
                <UButton size="sm" color="neutral" variant="ghost" :label="t('common.cancel')" @click="deleting = null" />
              </template>
              <template v-else>
                <UButton
                  size="sm"
                  color="neutral"
                  variant="ghost"
                  icon="i-lucide-pencil"
                  :aria-label="t('tickets.presets.rename')"
                  @click="editing = { id: view.id, name: view.name }"
                />
                <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-trash-2" :aria-label="t('common.delete')" @click="deleting = view.id" />
              </template>
            </template>
          </template>
        </li>
      </ul>
    </template>
  </UModal>
</template>
