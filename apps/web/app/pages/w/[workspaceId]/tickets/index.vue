<script setup lang="ts">
import {
  BULK_TICKETS_LIMIT,
  TICKET_PRIORITIES,
  TICKET_SORTS,
  type BulkUpdateTicketsResultDto,
  type TicketCountsDto,
  type TicketListDto,
  type TicketListRowDto,
  type TicketSort,
  type TicketViewDto,
} from '@kvitok/shared';
import type { DropdownMenuItem, TableColumn } from '@nuxt/ui';
import type { BulkTarget } from '~/components/ticket/BulkBar.vue';
import {
  TICKET_VIEWS,
  isTicketFilterKey,
  ticketFilterParams,
  type TicketFilterDef,
} from '~/utils/ticket-filters';

const route = useRoute();
const router = useRouter();
const { workspaceId, can, scope, canSee } = useWorkspace();
const { departments, members, channels, departmentById, memberById, ticketFields } = useWorkspaceData();

/** Where the queue's last state in this workspace is kept, for the next time it opens without a query. */
const lastKey = computed(() => `tickets:last:${workspaceId.value}`);
function loadLast(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(lastKey.value) ?? '{}') as Record<string, string>;
  } catch {
    // without localStorage the queue opens as is
    return {};
  }
}
const pickFilters = (state: Record<string, string>) => Object.fromEntries(Object.entries(state).filter(([key]) => isTicketFilterKey(key)));
const initial: Record<string, string> =
  Object.keys(route.query).length > 0
    ? Object.fromEntries(Object.entries(route.query).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : loadLast();

const view = ref(TICKET_VIEWS.find((v) => v.value === initial.view)?.value ?? 'open');
const sort = ref<TicketSort>(TICKET_SORTS.find((s) => s === initial.sort) ?? 'updated');
const search = ref(initial.q ?? '');
const searchQuery = refDebounced(search, 300);
const page = ref(Number(initial.page ?? 1));
/** Filters by their URL key; an empty value is a chip still being filled in. */
const filters = ref<Record<string, string>>(pickFilters(initial));
/** The chip whose popover is open. */
const openFilter = ref<string | null>(null);
/** The saved view the queue was opened from. */
const presetId = ref<string | null>(initial.preset ?? null);

/** The queue as a saved view keeps it: everything but the page. */
const queueState = computed<Record<string, string>>(() => ({
  view: view.value,
  ...(sort.value !== 'updated' ? { sort: sort.value } : {}),
  ...Object.fromEntries(Object.entries(filters.value).filter(([, value]) => value)),
  ...(search.value.trim() ? { q: search.value.trim() } : {}),
}));

function applyState(state: Record<string, string>, id: string | null): void {
  view.value = TICKET_VIEWS.find((v) => v.value === state.view)?.value ?? 'open';
  sort.value = TICKET_SORTS.find((s) => s === state.sort) ?? 'updated';
  search.value = state.q ?? '';
  filters.value = pickFilters(state);
  presetId.value = id;
}

function syncUrl(): void {
  const state = { ...queueState.value, ...(presetId.value ? { preset: presetId.value } : {}) };
  void router.replace({ query: { ...state, ...(page.value > 1 ? { page: String(page.value) } : {}) } });
  try {
    localStorage.setItem(lastKey.value, JSON.stringify(state));
  } catch {
    // not critical
  }
}
watch([queueState, presetId, page], syncUrl, { immediate: true });
// The sidebar link opens the queue without a query while it is already open: keep the state in the URL.
watch(
  () => route.query,
  (query) => {
    if (Object.keys(query).length === 0) syncUrl();
  },
);

/** The list's API parameters without the status and the page: shared by the list, the tab counts and bulk changes. */
const filterParams = computed(() => ({
  ...ticketFilterParams(filters.value),
  ...(searchQuery.value ? { q: searchQuery.value } : {}),
}));
const statuses = computed(() => TICKET_VIEWS.find((v) => v.value === view.value)?.statuses ?? []);
const listParams = computed(() => ({
  ...filterParams.value,
  ...(statuses.value.length ? { status: statuses.value.join(',') } : {}),
  sort: sort.value,
}));

watch(
  () => JSON.stringify(listParams.value),
  () => {
    page.value = 1;
    clearSelection();
  },
);

const query = computed(() => new URLSearchParams({ ...listParams.value, page: String(page.value), pageSize: '25' }).toString());
const countsQuery = computed(() => new URLSearchParams(filterParams.value).toString());

const { data, status, refresh } = await useAsyncData(
  () => `tickets:${workspaceId.value}:${query.value}`,
  () => api<TicketListDto>(`/workspaces/${workspaceId.value}/tickets?${query.value}`),
  { watch: [query], default: () => ({ items: [], total: 0, page: 1, pageSize: 25 }) },
);
const rows = computed(() => data.value.items as TicketListRowDto[]);
const { data: counts, refresh: refreshCounts } = await useAsyncData(
  () => `tickets:counts:${workspaceId.value}:${countsQuery.value}`,
  () => api<TicketCountsDto>(`/workspaces/${workspaceId.value}/tickets/counts?${countsQuery.value}`),
  { watch: [countsQuery], default: () => null },
);
const { data: tags, refresh: refreshTags } = await useAsyncData(
  () => `tickets:tags:${workspaceId.value}`,
  () => api<string[]>(`/workspaces/${workspaceId.value}/tickets/tags`),
  { default: () => [] },
);

function refreshAll(): void {
  void refresh();
  void refreshCounts();
}
useRealtime(debounce(refreshAll, 500));

const viewItems = computed(() =>
  TICKET_VIEWS.map(({ value, statuses: list }) => {
    const count = counts.value ? (list.length ? list : Object.keys(counts.value)).reduce((sum, s) => sum + (counts.value?.[s as keyof TicketCountsDto] ?? 0), 0) : null;
    return { label: t(`tickets.views.${value}`), value, ...(count ? { badge: { label: String(count), color: 'neutral' as const, variant: 'soft' as const } } : {}) };
  }),
);
const sortItems = TICKET_SORTS.map((value) => ({ label: t(`tickets.sort.${value}`), value }));
/** On phones the sort is an icon menu next to the views. */
const sortMenu = computed<DropdownMenuItem[]>(() =>
  sortItems.map((item) => ({
    label: item.label,
    type: 'checkbox' as const,
    checked: sort.value === item.value,
    onSelect: () => (sort.value = item.value),
  })),
);

/* Filters */

const filterDefs = computed<TicketFilterDef[]>(() => [
  { key: 'attention', label: t('tickets.filters.attention'), icon: 'i-lucide-hand', kind: 'flag' },
  {
    key: 'assignee',
    label: t('tickets.columns.assignee'),
    icon: 'i-lucide-user',
    kind: 'options',
    options: [
      { label: t('tickets.filters.mine'), value: 'me' },
      { label: t('tickets.filters.unassigned'), value: 'none' },
      ...members.data.value.filter((m) => m.role !== 'viewer').map((m) => ({ label: m.name, value: m.userId })),
    ],
  },
  {
    key: 'departmentId',
    label: t('tickets.columns.department'),
    icon: 'i-lucide-building-2',
    kind: 'options',
    // Only the departments whose tickets the user sees.
    options: [
      ...(canSee(null) ? [{ label: t('tickets.filters.noDepartment'), value: 'none' }] : []),
      ...departments.data.value.filter((d) => !d.archived && canSee(d.id)).map((d) => ({ label: d.title, value: d.id })),
    ],
  },
  {
    key: 'priority',
    label: t('tickets.filters.priority'),
    icon: 'i-lucide-signal',
    kind: 'options',
    options: [...TICKET_PRIORITIES].reverse().map((p) => ({ label: priorityLabel(p), value: p })),
  },
  {
    key: 'channelId',
    label: t('tickets.filters.channel'),
    icon: 'i-lucide-inbox',
    kind: 'options',
    options: channels.data.value.map((c) => ({ label: c.name, value: c.id })),
  },
  { key: 'tags', label: t('tickets.filters.tags'), icon: 'i-lucide-tag', kind: 'options', options: tags.value.map((tag) => ({ label: tag, value: tag })) },
  {
    key: 'agentState',
    label: t('tickets.filters.agentState'),
    icon: 'i-lucide-bot',
    kind: 'options',
    options: (['failed', 'running', 'queued'] as const).map((s) => ({ label: t(`ticket.agentState.${s}`), value: s })),
  },
  { key: 'created', label: t('tickets.filters.created'), icon: 'i-lucide-calendar-plus', kind: 'date' },
  { key: 'updated', label: t('tickets.filters.updated'), icon: 'i-lucide-calendar-clock', kind: 'date' },
  ...ticketFields.value
    .filter((f) => f.display.includes('filter'))
    .map((f): TicketFilterDef => {
      const base = { key: `field.${f.key}`, label: f.label, icon: 'i-lucide-list' };
      if (f.type === 'boolean') {
        return { ...base, kind: 'option', options: [{ label: t('common.yes'), value: 'true' }, { label: t('common.no'), value: 'false' }] };
      }
      return f.options.length ? { ...base, kind: 'option', options: f.options } : { ...base, kind: 'text' };
    }),
]);
const activeFilters = computed(() =>
  Object.keys(filters.value)
    .map((key) => filterDefs.value.find((d) => d.key === key))
    .filter((d) => d !== undefined),
);
const addFilterItems = computed<DropdownMenuItem[]>(() =>
  filterDefs.value
    .filter((d) => !(d.key in filters.value))
    .map((d) => ({ label: d.label, icon: d.icon, onSelect: () => addFilter(d) })),
);

function addFilter(def: TicketFilterDef): void {
  filters.value = { ...filters.value, [def.key]: def.kind === 'flag' ? 'true' : '' };
  if (def.kind !== 'flag') {
    // After the menu has closed: it does not return the focus, so the chip's popover stays open.
    setTimeout(() => (openFilter.value = def.key));
  }
}
function setFilter(key: string, value: string): void {
  filters.value = { ...filters.value, [key]: value };
}
function removeFilter(key: string): void {
  const { [key]: _, ...rest } = filters.value;
  filters.value = rest;
}
/** A chip closed without a value goes away. */
function setFilterOpen(key: string, open: boolean): void {
  openFilter.value = open ? key : openFilter.value === key ? null : openFilter.value;
  if (!open && !filters.value[key]) removeFilter(key);
}
function resetFilters(): void {
  filters.value = {};
  search.value = '';
  presetId.value = null;
}

/* Selection */

const selected = ref(new Set<string>());
/** Every ticket of the filter, not only the ones on the screen. */
const allMatching = ref(false);
const lastToggled = ref<number | null>(null);
let shiftPressed = false;
function rememberShift(event: PointerEvent): void {
  shiftPressed = event.shiftKey;
}

const pageSelected = computed(() => rows.value.length > 0 && rows.value.every((r) => selected.value.has(r.id)));
const headerChecked = computed(() => (pageSelected.value ? true : rows.value.some((r) => selected.value.has(r.id)) ? 'indeterminate' : false));
const selectedCount = computed(() => (allMatching.value ? data.value.total : selected.value.size));
const bulkTarget = computed<BulkTarget>(() =>
  allMatching.value ? { filter: Object.fromEntries(new URLSearchParams(listParams.value)) } : { ids: [...selected.value] },
);

function clearSelection(): void {
  selected.value = new Set();
  allMatching.value = false;
  lastToggled.value = null;
}
function togglePage(value: boolean | 'indeterminate'): void {
  const next = new Set(selected.value);
  for (const row of rows.value) {
    if (value === true) next.add(row.id);
    else next.delete(row.id);
  }
  selected.value = next;
  allMatching.value = false;
}
/** Shift extends the selection from the last toggled row. */
function toggleRow(index: number, value: boolean | 'indeterminate'): void {
  const from = shiftPressed && lastToggled.value !== null ? Math.min(lastToggled.value, index) : index;
  const to = shiftPressed && lastToggled.value !== null ? Math.max(lastToggled.value, index) : index;
  const next = new Set(selected.value);
  for (const row of rows.value.slice(from, to + 1)) {
    if (value === true) next.add(row.id);
    else next.delete(row.id);
  }
  selected.value = next;
  allMatching.value = false;
  lastToggled.value = index;
}

/** Tickets that refused the change stay selected, to deal with them. */
function onBulkDone(result: BulkUpdateTicketsResultDto): void {
  if (result.failed.length > 0) {
    selected.value = new Set(result.failed.map((f) => f.id));
    allMatching.value = false;
  } else {
    clearSelection();
  }
  refreshAll();
  void refreshTags();
}

/* Table, and a list of cards on phones */

const mobile = useMobile();

const listFields = computed(() => ticketFields.value.filter((f) => f.display.includes('list_column')));
const selectable = computed(() => can('operator'));

const columns = computed<TableColumn<TicketListRowDto>[]>(() => [
  ...(selectable.value ? [{ id: 'select' }] : []),
  { accessorKey: 'number', header: '#' },
  { accessorKey: 'subject', header: t('tickets.columns.subject') },
  { accessorKey: 'status', header: t('tickets.columns.status') },
  { accessorKey: 'departmentId', header: t('tickets.columns.department') },
  { id: 'assignee', header: t('tickets.columns.assignee') },
  ...listFields.value.map((f) => ({ id: `field_${f.key}`, header: f.label })),
  { accessorKey: 'lastMessageAt', header: t('tickets.columns.updated') },
]);

const AGENT_ICONS = {
  queued: { icon: 'i-lucide-clock', class: 'text-(--ui-text-muted)' },
  running: { icon: 'i-lucide-loader-circle', class: 'animate-spin text-(--ui-primary)' },
  failed: { icon: 'i-lucide-triangle-alert', class: 'text-(--ui-error)' },
} as const;

function open(row: TicketListRowDto): void {
  void navigateTo(`/w/${workspaceId.value}/tickets/${row.id}`);
}
</script>

<template>
  <UDashboardPanel id="tickets">
    <template #header>
      <UDashboardNavbar :title="t('nav.tickets')">
        <template #right>
          <UTooltip v-if="!scope.all" :text="t('tickets.scopeHint')">
            <UIcon name="i-lucide-building-2" class="size-4 text-(--ui-text-muted)" :aria-label="t('tickets.scopeHint')" />
          </UTooltip>
          <UInput v-model="search" icon="i-lucide-search" :placeholder="t('tickets.searchPlaceholder')" class="w-48 sm:w-72" />
        </template>
      </UDashboardNavbar>
      <UDashboardToolbar :ui="{ root: 'overflow-x-visible', left: 'min-w-0 overflow-x-auto', right: 'shrink-0' }">
        <template #left>
          <UTabs v-model="view" :items="viewItems" :content="false" size="sm" />
        </template>
        <template #right>
          <UDropdownMenu v-if="mobile" :items="sortMenu" :content="{ align: 'end' }">
            <UButton color="neutral" variant="ghost" icon="i-lucide-arrow-down-wide-narrow" :aria-label="t('tickets.sortBy')" />
          </UDropdownMenu>
          <USelect v-else v-model="sort" :items="sortItems" icon="i-lucide-arrow-down-wide-narrow" class="w-64" />
        </template>
      </UDashboardToolbar>
      <UDashboardToolbar>
        <div class="flex flex-wrap items-center gap-2 py-1">
          <TicketViewsMenu v-model:active-id="presetId" :query="queueState" @apply="(v: TicketViewDto) => applyState(v.query, v.id)" />
          <USeparator orientation="vertical" class="h-5" />
          <TicketFilterChip
            v-for="def in activeFilters"
            :key="def.key"
            :filter="def"
            :model-value="filters[def.key] ?? ''"
            :open="openFilter === def.key"
            @update:model-value="(value: string) => setFilter(def.key, value)"
            @update:open="(value: boolean) => setFilterOpen(def.key, value)"
            @remove="removeFilter(def.key)"
          />
          <UDropdownMenu v-if="addFilterItems.length" :items="addFilterItems" :content="{ align: 'start', onCloseAutoFocus: (e: Event) => e.preventDefault() }">
            <UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-list-filter" :label="t('tickets.filters.add')" />
          </UDropdownMenu>
          <UButton
            v-if="activeFilters.length || searchQuery"
            color="neutral"
            variant="link"
            size="sm"
            :label="t('tickets.filters.reset')"
            @click="resetFilters"
          />
        </div>
      </UDashboardToolbar>
    </template>

    <template #body>
      <div v-if="pageSelected && data.total > rows.length" class="flex items-center justify-center gap-2 rounded-md bg-(--ui-bg-elevated) px-3 py-2 text-sm">
        <template v-if="allMatching">
          <span>{{ t('tickets.selection.allMatching', { count: data.total }) }}</span>
          <UButton variant="link" size="sm" :label="t('tickets.selection.clear')" class="p-0" @click="clearSelection" />
        </template>
        <template v-else>
          <span>{{ t('tickets.selection.page', { count: rows.length }) }}</span>
          <UButton
            v-if="data.total <= BULK_TICKETS_LIMIT"
            variant="link"
            size="sm"
            :label="t('tickets.selection.selectAllMatching', { count: data.total })"
            class="p-0"
            @click="allMatching = true"
          />
          <span v-else class="text-(--ui-text-muted)">{{ t('tickets.selection.tooMany', { limit: BULK_TICKETS_LIMIT }) }}</span>
        </template>
      </div>

      <ul v-if="mobile && rows.length" class="-mx-4 -mt-4 divide-y divide-(--ui-border) border-b border-(--ui-border) sm:-mx-6 sm:-mt-6" :class="status === 'pending' ? 'opacity-60' : ''">
        <li v-for="(row, index) in rows" :key="row.id" class="flex">
          <div v-if="selectable" class="flex items-start py-3.5 pr-1 pl-4 sm:pl-6">
            <UCheckbox
              :model-value="allMatching || selected.has(row.id)"
              :aria-label="t('tickets.selection.selectRow', { number: row.number })"
              @update:model-value="(value: boolean | 'indeterminate') => toggleRow(index, value)"
            />
          </div>
          <NuxtLink
            :to="`/w/${workspaceId}/tickets/${row.id}`"
            class="min-w-0 flex-1 space-y-1 py-3 pr-4 active:bg-(--ui-bg-elevated) sm:pr-6"
            :class="selectable ? 'pl-2' : 'pl-4 sm:pl-6'"
          >
            <div class="flex items-center gap-2 text-xs text-(--ui-text-muted)">
              <span class="shrink-0">T-{{ row.number }}</span>
              <span class="truncate">
                {{ row.customer?.name ?? row.customer?.primaryIdentity?.value ?? t('tickets.noCustomer') }}
                <template v-if="row.channel"> · {{ row.channel.name }}</template>
              </span>
              <span class="ml-auto shrink-0" :title="formatDateTime(row.lastMessageAt)">{{ formatRelative(row.lastMessageAt) }}</span>
            </div>
            <p class="flex items-start gap-1.5 font-medium">
              <UIcon v-if="row.attention" name="i-lucide-hand" class="mt-0.5 size-4 shrink-0 text-(--ui-warning)" :title="t('tickets.filters.attention')" />
              <span class="line-clamp-2">{{ row.subject }}</span>
            </p>
            <div class="flex flex-wrap items-center gap-1.5 text-xs text-(--ui-text-muted)">
              <UBadge :color="STATUS_COLORS[row.status]" variant="subtle" size="sm">{{ statusLabel(row.status) }}</UBadge>
              <UBadge v-if="row.priority === 'high' || row.priority === 'urgent'" :color="PRIORITY_COLORS[row.priority]" variant="outline" size="sm">
                {{ priorityLabel(row.priority) }}
              </UBadge>
              <UIcon
                v-if="row.agentState !== 'idle'"
                :name="AGENT_ICONS[row.agentState].icon"
                class="size-4"
                :class="AGENT_ICONS[row.agentState].class"
                :title="t(`ticket.agentState.${row.agentState}`)"
              />
              <span class="truncate">
                {{ row.departmentId ? (departmentById.get(row.departmentId)?.title ?? '—') : '—' }}
                · {{ row.assignee ? (memberById.get(row.assignee.id)?.name ?? row.assignee.name) : t('tickets.filters.unassigned') }}
              </span>
            </div>
            <div v-if="listFields.length || row.tags.length" class="flex flex-wrap items-center gap-1.5 text-xs text-(--ui-text-muted)">
              <template v-for="field in listFields" :key="field.key">
                <span v-if="row.fields[field.key] !== undefined && row.fields[field.key] !== null">
                  {{ field.label }}: {{ formatFieldValue(row.fields[field.key], field.options) }}
                </span>
              </template>
              <UBadge v-for="tag in row.tags.slice(0, 3)" :key="tag" size="sm" color="neutral" variant="soft">{{ tag }}</UBadge>
              <span v-if="row.tags.length > 3">+{{ row.tags.length - 3 }}</span>
            </div>
          </NuxtLink>
        </li>
      </ul>
      <template v-else-if="mobile">
        <UEmpty
          v-if="activeFilters.length || searchQuery"
          icon="i-lucide-list-filter"
          :title="t('tickets.empty.filteredTitle')"
          :description="t('tickets.empty.filteredDescription')"
          :actions="[{ label: t('tickets.filters.reset'), color: 'neutral', variant: 'subtle', onClick: resetFilters }]"
        />
        <UEmpty v-else-if="status !== 'pending'" icon="i-lucide-inbox" :title="t('tickets.empty.title')" :description="t('tickets.empty.description')" />
      </template>

      <UTable
        v-else
        :data="rows"
        :columns="columns"
        :loading="status === 'pending'"
        class="cursor-pointer"
        :on-select="(_e: Event, row: { original: TicketListRowDto }) => open(row.original)"
      >
        <template #select-header>
          <UCheckbox :model-value="headerChecked" :aria-label="t('tickets.selection.selectPage')" @update:model-value="togglePage" />
        </template>
        <template #select-cell="{ row }">
          <div class="-m-2 flex p-2" @click.stop @pointerdown="rememberShift">
            <UCheckbox
              :model-value="allMatching || selected.has(row.original.id)"
              :aria-label="t('tickets.selection.selectRow', { number: row.original.number })"
              @update:model-value="(value: boolean | 'indeterminate') => toggleRow(row.index, value)"
            />
          </div>
        </template>
        <template #number-cell="{ row }">
          <span class="text-(--ui-text-muted)">T-{{ row.original.number }}</span>
        </template>
        <template #subject-cell="{ row }">
          <div class="max-w-md">
            <p class="flex items-center gap-1.5">
              <UIcon
                v-if="row.original.attention"
                name="i-lucide-hand"
                class="size-4 shrink-0 text-(--ui-warning)"
                :title="t('tickets.filters.attention')"
              />
              <span class="truncate font-medium">{{ row.original.subject }}</span>
            </p>
            <p class="flex items-center gap-1 truncate text-xs text-(--ui-text-muted)">
              <span class="truncate">
                {{ row.original.customer?.name ?? row.original.customer?.primaryIdentity?.value ?? t('tickets.noCustomer') }}
                <template v-if="row.original.channel"> · {{ row.original.channel.name }}</template>
              </span>
              <UBadge v-for="tag in row.original.tags.slice(0, 3)" :key="tag" size="sm" color="neutral" variant="soft">{{ tag }}</UBadge>
              <span v-if="row.original.tags.length > 3">+{{ row.original.tags.length - 3 }}</span>
            </p>
          </div>
        </template>
        <template #status-cell="{ row }">
          <div class="flex items-center gap-1">
            <UBadge :color="STATUS_COLORS[row.original.status]" variant="subtle">{{ statusLabel(row.original.status) }}</UBadge>
            <UBadge v-if="row.original.priority === 'high' || row.original.priority === 'urgent'" :color="PRIORITY_COLORS[row.original.priority]" variant="outline">
              {{ priorityLabel(row.original.priority) }}
            </UBadge>
            <UIcon
              v-if="row.original.agentState !== 'idle'"
              :name="AGENT_ICONS[row.original.agentState].icon"
              class="size-4"
              :class="AGENT_ICONS[row.original.agentState].class"
              :title="t(`ticket.agentState.${row.original.agentState}`)"
            />
          </div>
        </template>
        <template #departmentId-cell="{ row }">
          {{ row.original.departmentId ? (departmentById.get(row.original.departmentId)?.title ?? '—') : '—' }}
        </template>
        <template #assignee-cell="{ row }">
          {{ row.original.assignee ? (memberById.get(row.original.assignee.id)?.name ?? row.original.assignee.name) : '—' }}
        </template>
        <template v-for="field in listFields" :key="field.key" #[`field_${field.key}-cell`]="{ row }">
          {{ formatFieldValue(row.original.fields[field.key], field.options) }}
        </template>
        <template #lastMessageAt-cell="{ row }">
          <span class="text-(--ui-text-muted)" :title="formatDateTime(row.original.lastMessageAt)">{{ formatRelative(row.original.lastMessageAt) }}</span>
        </template>
        <template #empty>
          <UEmpty
            v-if="activeFilters.length || searchQuery"
            icon="i-lucide-list-filter"
            :title="t('tickets.empty.filteredTitle')"
            :description="t('tickets.empty.filteredDescription')"
            :actions="[{ label: t('tickets.filters.reset'), color: 'neutral', variant: 'subtle', onClick: resetFilters }]"
          />
          <UEmpty v-else icon="i-lucide-inbox" :title="t('tickets.empty.title')" :description="t('tickets.empty.description')" />
        </template>
      </UTable>

      <div v-if="data.total > data.pageSize" class="flex justify-center border-t border-(--ui-border) pt-4">
        <UPagination v-model:page="page" :total="data.total" :items-per-page="data.pageSize" :sibling-count="mobile ? 0 : 2" />
      </div>

      <div v-if="selectedCount > 0" class="sticky bottom-4 z-10 mx-auto mt-auto w-fit">
        <TicketBulkBar :count="selectedCount" :target="bulkTarget" :tags="tags" @done="onBulkDone" @clear="clearSelection" />
      </div>
    </template>
  </UDashboardPanel>
</template>
