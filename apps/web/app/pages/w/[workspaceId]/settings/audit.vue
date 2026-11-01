<script setup lang="ts">
import { AUDIT_ENTITIES, type AuditEntity, type AuditLogDto, type MemberDepartmentsInput } from '@kvitok/shared';
import type { TableColumn } from '@nuxt/ui';

const PAGE = 50;
const ALL = 'all';

const { workspaceId } = useWorkspace();
const { departmentById } = useWorkspaceData();
const entity = ref<AuditEntity | typeof ALL>(ALL);
const entries = ref<AuditLogDto[]>([]);
const hasMore = ref(false);
const loading = ref(false);

const entityItems = [
  { label: t('audit.allEntities'), value: ALL },
  // User changes belong to the installation, not to a workspace.
  ...AUDIT_ENTITIES.filter((value) => value !== 'user').map((value) => ({ label: t(`audit.entity.${value}`), value })),
];

const columns: TableColumn<AuditLogDto>[] = [
  { accessorKey: 'createdAt', header: t('audit.when') },
  { id: 'who', header: t('audit.who') },
  { id: 'what', header: t('audit.what') },
  { id: 'changes', header: t('audit.changes') },
];

async function load(append = false): Promise<void> {
  loading.value = true;
  try {
    const query = new URLSearchParams({ limit: String(PAGE) });
    if (entity.value !== ALL) query.set('entity', entity.value);
    const last = entries.value.at(-1);
    if (append && last) query.set('cursor', last.id);
    const page = await api<AuditLogDto[]>(`/workspaces/${workspaceId.value}/audit?${query}`);
    entries.value = append ? [...entries.value, ...page] : page;
    hasMore.value = page.length === PAGE;
  } finally {
    loading.value = false;
  }
}

watch([workspaceId, entity], () => load(), { immediate: true });

function who(entry: AuditLogDto): string {
  if (entry.actor.type === 'system') return t('audit.system');
  const name = entry.actor.name ?? '—';
  return entry.actor.tokenName ? t('audit.viaToken', { name, token: entry.actor.tokenName }) : name;
}

/** The entity's name to tell entries apart: a department title, a rule name, a field label. */
function subject(entry: AuditLogDto): string {
  const view = entry.after ?? entry.before ?? {};
  for (const key of ['title', 'name', 'label', 'key', 'email']) {
    if (typeof view[key] === 'string' && view[key]) return view[key] as string;
  }
  return '';
}

function short(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text === undefined ? '—' : text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/** A member's departments by title. */
function departmentsText(value: MemberDepartmentsInput): string {
  if (value.allDepartments) return t('members.allDepartments');
  return value.departmentIds.map((id) => departmentById.value.get(id)?.title ?? '—').join(', ') || t('common.none');
}

/** Top-level fields that differ; for a creation — nothing, the entity itself is the change. */
function changes(entry: AuditLogDto): Array<{ key: string; before: string; after: string }> {
  if (entry.before === null || entry.after === null) return [];
  const show = (key: string, value: unknown) =>
    entry.entity === 'member' && key === 'departments' && value ? departmentsText(value as MemberDepartmentsInput) : short(value);
  const keys = new Set([...Object.keys(entry.before), ...Object.keys(entry.after)]);
  return [...keys]
    .filter((key) => JSON.stringify(entry.before![key]) !== JSON.stringify(entry.after![key]))
    .map((key) => ({ key, before: show(key, entry.before![key]), after: show(key, entry.after![key]) }));
}
</script>

<template>
  <UDashboardPanel id="audit">
    <template #header>
      <UDashboardNavbar :title="t('nav.audit')">
        <template #right>
          <USelect v-model="entity" :items="entityItems" class="w-40 sm:w-56" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <p class="mb-4 max-w-2xl text-sm text-(--ui-text-muted)">
        {{ t('audit.intro') }}
      </p>
      <ResponsiveTable :data="entries" :columns="columns" :loading="loading" :ui="{ td: 'whitespace-normal align-top' }">
        <template #createdAt-cell="{ row }">
          <span class="whitespace-nowrap text-(--ui-text-muted)">{{ formatDateTime(row.original.createdAt) }}</span>
        </template>
        <template #who-cell="{ row }">
          <span class="flex items-start gap-1.5">
            <UIcon v-if="row.original.actor.type === 'token'" name="i-lucide-key-round" class="mt-0.5 shrink-0 text-(--ui-text-muted)" />
            <span>{{ who(row.original) }}</span>
          </span>
        </template>
        <template #what-cell="{ row }">
          <p>{{ t(`audit.entity.${row.original.entity}`) }} · {{ t(`audit.action.${row.original.action}`) }}</p>
          <p v-if="subject(row.original)" class="text-(--ui-text-muted)">{{ subject(row.original) }}</p>
        </template>
        <template #changes-cell="{ row }">
          <ul class="max-w-xl space-y-0.5 font-mono text-xs">
            <li v-for="change in changes(row.original)" :key="change.key" class="whitespace-normal break-words">
              <span class="text-(--ui-text-muted)">{{ change.key }}:</span>
              <span class="text-(--ui-error) line-through">{{ change.before }}</span>
              →
              <span class="text-(--ui-success)">{{ change.after }}</span>
            </li>
          </ul>
        </template>
        <template #empty>
          <UEmpty icon="i-lucide-history" :title="t('audit.empty')" />
        </template>
      </ResponsiveTable>
      <div v-if="hasMore" class="mt-4 flex justify-center">
        <UButton color="neutral" variant="soft" :loading="loading" @click="load(true)">{{ t('audit.loadMore') }}</UButton>
      </div>
    </template>
  </UDashboardPanel>
</template>
