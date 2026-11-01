<script setup lang="ts">
import type { SandboxEmailDto, SandboxEmailListDto, SandboxEmailListItemDto } from '@kvitok/shared';
import type { TableColumn } from '@nuxt/ui';

const route = useRoute();
const router = useRouter();
const toast = useToast();
const { workspaceId, can } = useWorkspace();
const { channels } = useWorkspaceData();
const channelId = computed(() => String(route.params.channelId));
const channel = computed(() => channels.data.value.find((c) => c.id === channelId.value) ?? null);
const base = computed(() => `/workspaces/${workspaceId.value}/channels/${channelId.value}/outbox`);

const address = ref(String(route.query.address ?? ''));
const addressQuery = refDebounced(address, 300);
const page = ref(Number(route.query.page ?? 1));
/** The open email is in the URL so a ticket can link to it. */
const selectedId = ref<string | null>(route.query.email ? String(route.query.email) : null);

watch(addressQuery, () => {
  page.value = 1;
});
watch([addressQuery, page, selectedId], () => {
  void router.replace({
    query: {
      ...(addressQuery.value ? { address: addressQuery.value } : {}),
      ...(page.value > 1 ? { page: String(page.value) } : {}),
      ...(selectedId.value ? { email: selectedId.value } : {}),
    },
  });
});

const query = computed(() => {
  const params = new URLSearchParams({ page: String(page.value), pageSize: '25' });
  if (addressQuery.value) params.set('address', addressQuery.value);
  return params.toString();
});

const { data, status, refresh } = await useAsyncData(
  () => `outbox:${channelId.value}:${query.value}`,
  () => api<SandboxEmailListDto>(`${base.value}?${query.value}`),
  { watch: [query], default: () => ({ items: [], total: 0, page: 1, pageSize: 25 }) },
);
useRealtime((event) => {
  if (event.type === 'delivery.updated') void refresh();
});

const { data: email, status: emailStatus } = await useAsyncData(
  () => `outbox-email:${selectedId.value ?? 'none'}`,
  () => (selectedId.value ? api<SandboxEmailDto>(`${base.value}/${selectedId.value}`) : Promise.resolve(null)),
  { watch: [selectedId] },
);

const columns: TableColumn<SandboxEmailListItemDto>[] = [
  { accessorKey: 'to', header: t('reply.to') },
  { accessorKey: 'subject', header: t('tickets.columns.subject') },
  { id: 'ticket', header: t('outbox.ticket') },
  { accessorKey: 'createdAt', header: t('outbox.when') },
];

const view = ref<'html' | 'text' | 'headers'>('html');
const VIEWS = [
  { label: t('outbox.views.html'), value: 'html' },
  { label: t('outbox.views.text'), value: 'text' },
  { label: t('outbox.views.headers'), value: 'headers' },
];
watch(selectedId, () => (view.value = 'html'));

/** Email HTML goes into an isolated iframe, as in the ticket timeline. */
const srcdoc = computed(
  () =>
    `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{font:14px/1.5 system-ui,sans-serif;margin:12px;color:#1f2937;word-break:break-word}img{max-width:100%}blockquote{border-left:3px solid #d1d5db;margin:0;padding-left:8px;color:#6b7280}</style></head><body>${email.value?.html ?? ''}</body></html>`,
);

const clearOpen = ref(false);
async function clear(): Promise<void> {
  try {
    const { deleted } = await api<{ deleted: number }>(base.value, { method: 'DELETE' });
    clearOpen.value = false;
    selectedId.value = null;
    page.value = 1;
    await refresh();
    toast.add({ title: tp('outbox.cleared', deleted), icon: 'i-lucide-trash-2' });
  } catch (e) {
    toast.add({ color: 'error', title: e instanceof ApiError ? e.message : t('outbox.clearFailed') });
  }
}
</script>

<template>
  <UDashboardPanel id="outbox">
    <template #header>
      <UDashboardNavbar :title="channel ? `${t('outbox.title')} · ${channel.name}` : t('outbox.title')">
        <template #leading>
          <UButton icon="i-lucide-arrow-left" color="neutral" variant="ghost" :to="`/w/${workspaceId}/settings/channels`" :aria-label="t('outbox.backToChannels')" />
        </template>
        <template #right>
          <UInput v-model="address" icon="i-lucide-search" :placeholder="t('outbox.recipientAddress')" class="w-40 sm:w-64" />
          <UButton v-if="can('admin') && data.total > 0" icon="i-lucide-trash-2" color="neutral" variant="soft" :label="t('common.clear')" @click="clearOpen = true" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UAlert
        color="warning"
        variant="subtle"
        icon="i-lucide-flask-conical"
        :title="t('channels.sandbox')"
        :description="t('outbox.notice', { address: channel?.address ?? '' })"
      />

      <ResponsiveTable
        :data="data.items"
        :columns="columns"
        :loading="status === 'pending'"
        class="cursor-pointer"
        :on-select="(_e: Event, row: { original: SandboxEmailListItemDto }) => (selectedId = row.original.id)"
      >
        <template #to-cell="{ row }">
          <div class="max-w-64">
            <p class="truncate font-medium">{{ row.original.to.join(', ') || '—' }}</p>
            <p v-if="row.original.cc.length" class="truncate text-xs text-(--ui-text-muted)">{{ t('outbox.ccLine', { cc: row.original.cc.join(', ') }) }}</p>
          </div>
        </template>
        <template #subject-cell="{ row }">
          <div class="flex max-w-md items-center gap-1">
            <span class="truncate">{{ row.original.subject || t('outbox.noSubject') }}</span>
            <UIcon v-if="row.original.attachmentCount" name="i-lucide-paperclip" class="size-3.5 shrink-0 text-(--ui-text-muted)" />
          </div>
        </template>
        <template #ticket-cell="{ row }">
          <ULink v-if="row.original.ticket" :to="`/w/${workspaceId}/tickets/${row.original.ticket.id}`" class="text-(--ui-primary)" @click.stop>
            T-{{ row.original.ticket.number }}
          </ULink>
          <span v-else class="text-(--ui-text-muted)">—</span>
        </template>
        <template #createdAt-cell="{ row }">
          <span class="text-(--ui-text-muted)" :title="formatDateTime(row.original.createdAt)">{{ formatRelative(row.original.createdAt) }}</span>
        </template>
        <template #empty>
          <UEmpty
            icon="i-lucide-inbox"
            :title="t('outbox.empty.title')"
            :description="t('outbox.empty.description')"
          />
        </template>
      </ResponsiveTable>

      <div v-if="data.total > data.pageSize" class="flex justify-center border-t border-(--ui-border) pt-4">
        <UPagination v-model:page="page" :total="data.total" :items-per-page="data.pageSize" />
      </div>

      <USlideover
        :open="selectedId !== null"
        :title="email?.subject || t('outbox.views.html')"
        :ui="{ content: 'max-w-3xl', title: 'pr-8' }"
        @update:open="(v: boolean) => !v && (selectedId = null)"
      >
        <template #body>
          <div v-if="emailStatus === 'pending' && !email" class="text-sm text-(--ui-text-muted)">{{ t('common.loading') }}</div>
          <div v-else-if="email" class="space-y-4 text-sm">
            <dl class="space-y-1">
              <div class="flex gap-2"><dt class="w-24 shrink-0 text-(--ui-text-muted)">{{ t('outbox.from') }}</dt><dd>{{ email.from.name ? `${email.from.name} <${email.from.address}>` : email.from.address }}</dd></div>
              <div class="flex gap-2"><dt class="w-24 shrink-0 text-(--ui-text-muted)">{{ t('reply.to') }}</dt><dd class="font-medium">{{ email.to.join(', ') || '—' }}</dd></div>
              <div v-if="email.cc.length" class="flex gap-2"><dt class="w-24 shrink-0 text-(--ui-text-muted)">{{ t('reply.cc') }}</dt><dd>{{ email.cc.join(', ') }}</dd></div>
              <div class="flex gap-2"><dt class="w-24 shrink-0 text-(--ui-text-muted)">{{ t('outbox.when') }}</dt><dd>{{ formatDateTime(email.createdAt) }}</dd></div>
              <div class="flex gap-2"><dt class="w-24 shrink-0 text-(--ui-text-muted)">Message-ID</dt><dd class="truncate font-mono text-xs">{{ email.messageId ?? '—' }}</dd></div>
              <div v-if="email.inReplyTo" class="flex gap-2"><dt class="w-24 shrink-0 text-(--ui-text-muted)">In-Reply-To</dt><dd class="truncate font-mono text-xs">{{ email.inReplyTo }}</dd></div>
            </dl>

            <div class="flex flex-wrap gap-2">
              <UButton size="xs" variant="soft" icon="i-lucide-download" :href="`/api${base}/${email.id}/raw`" external>{{ t('outbox.downloadEml') }}</UButton>
              <UButton v-if="email.ticket" size="xs" variant="soft" color="neutral" icon="i-lucide-ticket" :to="`/w/${workspaceId}/tickets/${email.ticket.id}`">
                {{ t('outbox.ticketNumber', { number: email.ticket.number }) }}
              </UButton>
            </div>

            <div v-if="email.attachments.length" class="flex flex-wrap gap-2">
              <UBadge v-for="(attachment, index) in email.attachments" :key="index" color="neutral" variant="outline" icon="i-lucide-paperclip">
                {{ attachment.filename }} · {{ formatBytes(attachment.size) }}
              </UBadge>
            </div>

            <UTabs v-model="view" :items="VIEWS" :content="false" size="sm" />
            <iframe
              v-if="view === 'html' && email.html"
              :srcdoc="srcdoc"
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              class="h-96 w-full rounded-md border border-(--ui-border) bg-white"
              :title="t('outbox.views.html')"
            />
            <pre v-else-if="view === 'html' || view === 'text'" class="whitespace-pre-wrap rounded-md bg-(--ui-bg-muted) p-3 text-xs">{{ email.text }}</pre>
            <dl v-else class="space-y-1 font-mono text-xs">
              <div v-for="(header, index) in email.headers" :key="index" class="flex gap-2">
                <dt class="w-40 shrink-0 text-(--ui-text-muted)">{{ header.key }}</dt>
                <dd class="break-all">{{ header.value }}</dd>
              </div>
            </dl>
          </div>
        </template>
      </USlideover>

      <UModal v-model:open="clearOpen" :title="t('outbox.confirmClear.title')" :description="t('outbox.confirmClear.description')">
        <template #footer>
          <UButton color="neutral" variant="ghost" @click="clearOpen = false">{{ t('common.cancel') }}</UButton>
          <UButton color="error" @click="clear">{{ t('common.clear') }}</UButton>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
