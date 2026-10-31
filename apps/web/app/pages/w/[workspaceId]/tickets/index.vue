<script setup lang="ts">
import type { TicketListDto, TicketListItemDto, TicketStatus } from '@kvitok/shared';
import type { TableColumn } from '@nuxt/ui';

const route = useRoute();
const router = useRouter();
const { workspaceId } = useWorkspace();
const { departments, departmentById, memberById, ticketFields } = useWorkspaceData();

const VIEWS: Array<{ label: string; value: string; statuses: TicketStatus[] }> = [
  { label: t('tickets.views.open'), value: 'open', statuses: ['new', 'open'] },
  { label: t('tickets.views.pending'), value: 'pending', statuses: ['pending'] },
  { label: t('tickets.views.done'), value: 'done', statuses: ['resolved', 'closed'] },
  { label: t('tickets.views.all'), value: 'all', statuses: [] },
];

const view = ref(String(route.query.view ?? 'open'));
const assignee = ref(String(route.query.assignee ?? 'all'));
const departmentId = ref(String(route.query.department ?? 'all'));
const search = ref(String(route.query.q ?? ''));
const searchQuery = refDebounced(search, 300);
const page = ref(Number(route.query.page ?? 1));

watch([view, assignee, departmentId, searchQuery], () => {
  page.value = 1;
});
watch([view, assignee, departmentId, searchQuery, page], () => {
  void router.replace({
    query: {
      view: view.value,
      ...(assignee.value !== 'all' ? { assignee: assignee.value } : {}),
      ...(departmentId.value !== 'all' ? { department: departmentId.value } : {}),
      ...(searchQuery.value ? { q: searchQuery.value } : {}),
      ...(page.value > 1 ? { page: String(page.value) } : {}),
    },
  });
});

const query = computed(() => {
  const params = new URLSearchParams({ page: String(page.value), pageSize: '25' });
  const statuses = VIEWS.find((v) => v.value === view.value)?.statuses ?? [];
  if (statuses.length) params.set('status', statuses.join(','));
  if (assignee.value !== 'all') params.set('assignee', assignee.value);
  if (departmentId.value !== 'all') params.set('departmentId', departmentId.value);
  if (searchQuery.value) params.set('q', searchQuery.value);
  return params.toString();
});

const { data, status, refresh } = await useAsyncData(
  () => `tickets:${workspaceId.value}:${query.value}`,
  () => api<TicketListDto>(`/workspaces/${workspaceId.value}/tickets?${query.value}`),
  { watch: [query], default: () => ({ items: [], total: 0, page: 1, pageSize: 25 }) },
);

useRealtime(debounce(() => void refresh(), 500));

const listFields = computed(() => ticketFields.value.filter((f) => f.display.includes('list_column')));

const columns = computed<TableColumn<TicketListItemDto>[]>(() => [
  { accessorKey: 'number', header: '#' },
  { accessorKey: 'subject', header: t('tickets.columns.subject') },
  { accessorKey: 'status', header: t('tickets.columns.status') },
  { accessorKey: 'departmentId', header: t('tickets.columns.department') },
  { id: 'assignee', header: t('tickets.columns.assignee') },
  ...listFields.value.map((f) => ({ id: `field_${f.key}`, header: f.label })),
  { accessorKey: 'lastMessageAt', header: t('tickets.columns.updated') },
]);

const departmentItems = computed(() => [
  { label: t('tickets.filters.allDepartments'), value: 'all' },
  { label: t('tickets.filters.noDepartment'), value: 'none' },
  ...departments.data.value.filter((d) => !d.archived).map((d) => ({ label: d.title, value: d.id })),
]);
const assigneeItems = [
  { label: t('tickets.filters.anyone'), value: 'all' },
  { label: t('tickets.filters.mine'), value: 'me' },
  { label: t('tickets.filters.unassigned'), value: 'none' },
];

function open(row: TicketListItemDto): void {
  void navigateTo(`/w/${workspaceId.value}/tickets/${row.id}`);
}
</script>

<template>
  <UDashboardPanel id="tickets">
    <template #header>
      <UDashboardNavbar :title="t('nav.tickets')">
        <template #right>
          <UInput v-model="search" icon="i-lucide-search" :placeholder="t('tickets.searchPlaceholder')" class="w-72" />
        </template>
      </UDashboardNavbar>
      <UDashboardToolbar>
        <template #left>
          <UTabs v-model="view" :items="VIEWS.map(({ label, value }) => ({ label, value }))" :content="false" size="sm" />
        </template>
        <template #right>
          <USelect v-model="departmentId" :items="departmentItems" class="w-44" />
          <USelect v-model="assignee" :items="assigneeItems" class="w-44" />
        </template>
      </UDashboardToolbar>
    </template>

    <template #body>
      <UTable
        :data="data.items"
        :columns="columns"
        :loading="status === 'pending'"
        class="cursor-pointer"
        :on-select="(_e: Event, row: { original: TicketListItemDto }) => open(row.original)"
      >
        <template #number-cell="{ row }">
          <span class="text-(--ui-text-muted)">T-{{ row.original.number }}</span>
        </template>
        <template #subject-cell="{ row }">
          <div class="max-w-md">
            <p class="truncate font-medium">{{ row.original.subject }}</p>
            <p class="truncate text-xs text-(--ui-text-muted)">
              {{ row.original.customer?.name ?? row.original.customer?.primaryIdentity?.value ?? t('tickets.noCustomer') }}
              <template v-if="row.original.channel"> · {{ row.original.channel.name }}</template>
            </p>
          </div>
        </template>
        <template #status-cell="{ row }">
          <div class="flex items-center gap-1">
            <UBadge :color="STATUS_COLORS[row.original.status]" variant="subtle">{{ statusLabel(row.original.status) }}</UBadge>
            <UBadge v-if="row.original.priority === 'high' || row.original.priority === 'urgent'" :color="PRIORITY_COLORS[row.original.priority]" variant="outline">
              {{ priorityLabel(row.original.priority) }}
            </UBadge>
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
          <UEmpty icon="i-lucide-inbox" :title="t('tickets.empty.title')" :description="t('tickets.empty.description')" />
        </template>
      </UTable>

      <div v-if="data.total > data.pageSize" class="flex justify-center border-t border-(--ui-border) pt-4">
        <UPagination v-model:page="page" :total="data.total" :items-per-page="data.pageSize" />
      </div>
    </template>
  </UDashboardPanel>
</template>
