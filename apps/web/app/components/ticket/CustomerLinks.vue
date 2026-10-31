<script setup lang="ts">
import type { CustomerLinkDto, TicketDto } from '@kvitok/shared';

/** The customer in external systems (integrations): found or not, candidates, manual search and choice. */
const props = defineProps<{ ticket: TicketDto }>();
const toast = useToast();
const { workspaceId, can } = useWorkspace();
const editable = computed(() => can('operator'));
const base = computed(() => `/workspaces/${workspaceId.value}/tickets/${props.ticket.id}/customer-links`);

const links = ref<CustomerLinkDto[]>([]);
async function load(): Promise<void> {
  links.value = await api<CustomerLinkDto[]>(base.value).catch(() => []);
}
// The ticket is reloaded after agent runs and events — the links along with it.
watch(() => props.ticket, load, { immediate: true });

const STATUS_COLORS: Record<CustomerLinkDto['status'], 'success' | 'warning' | 'neutral' | 'info'> = {
  found: 'success',
  ambiguous: 'warning',
  not_found: 'neutral',
  unresolved: 'info',
};
const KNOWN_IDENTITIES = ['phone', 'email', 'card_number'] as const;
function identityLabel(type: string): string {
  const known = KNOWN_IDENTITIES.find((k) => k === type);
  return known ? t(`customerLinks.identity.${known}`) : type;
}

const search = reactive<Record<string, { type: string; value: string }>>({});
const formFor = (link: CustomerLinkDto) => (search[link.integrationId] ??= { type: link.identityTypes[0] ?? 'phone', value: '' });
const busy = ref<string | null>(null);

async function link(target: CustomerLinkDto, body: Record<string, unknown>): Promise<void> {
  busy.value = target.integrationId;
  try {
    const result = await api<{ outcome: 'found' | 'not_found' | 'ambiguous'; link: CustomerLinkDto }>(`${base.value}/${target.integrationId}`, { method: 'POST', body });
    links.value = links.value.map((l) => (l.integrationId === target.integrationId ? result.link : l));
    if (result.outcome === 'found') {
      toast.add({ color: 'success', title: t('customerLinks.found', { customer: result.link.displayName ?? result.link.customerRef ?? '' }), description: t('customerLinks.agentWillRefine') });
      formFor(target).value = '';
    } else {
      toast.add({ color: 'warning', title: result.outcome === 'ambiguous' ? t('customerLinks.ambiguous') : t('customerLinks.notFound') });
    }
  } catch (e) {
    toast.add({ color: 'error', title: e instanceof ApiError ? e.message : t('customerLinks.searchFailed') });
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <div v-for="item in links" :key="item.integrationId" class="space-y-2 rounded-md border border-(--ui-border) p-2.5 text-sm">
    <div class="flex items-center gap-2">
      <UIcon name="i-lucide-plug" class="shrink-0 text-(--ui-text-muted)" />
      <span class="min-w-0 flex-1 truncate font-medium">{{ item.integrationName }}</span>
      <UBadge :color="STATUS_COLORS[item.status]" variant="subtle" size="sm">{{ t(`customerLinks.status.${item.status}`) }}</UBadge>
    </div>

    <p v-if="item.status === 'found'" class="text-(--ui-text-muted)">
      {{ item.displayName ?? t('ticket.sidebar.noName') }} · <code class="text-xs">{{ item.customerRef }}</code>
      <span v-if="item.source === 'manual'"> · {{ t('customerLinks.linkedByOperator') }}</span>
    </p>
    <p v-else-if="item.status === 'unresolved'" class="text-(--ui-text-muted)">{{ t('customerLinks.agentWillFind') }}</p>
    <p v-if="item.lastError" class="text-xs text-(--ui-error)">{{ item.lastError }}</p>

    <ul v-if="item.status === 'ambiguous'" class="space-y-1">
      <li v-for="candidate in item.candidates" :key="candidate.customerRef" class="flex items-center gap-2">
        <span class="min-w-0 flex-1 truncate">{{ candidate.displayName }}<span v-if="candidate.hint" class="text-(--ui-text-muted)"> · {{ candidate.hint }}</span></span>
        <UButton v-if="editable" size="xs" variant="outline" :loading="busy === item.integrationId" @click="link(item, { customerRef: candidate.customerRef })">{{ t('customerLinks.choose') }}</UButton>
      </li>
    </ul>

    <form v-if="editable && item.status !== 'found'" class="flex gap-1" @submit.prevent="link(item, { identities: { [formFor(item).type]: formFor(item).value } })">
      <USelect
        v-model="formFor(item).type"
        :items="item.identityTypes.map((type) => ({ label: identityLabel(type), value: type }))"
        size="xs"
        class="w-28 shrink-0"
      />
      <UInput v-model="formFor(item).value" size="xs" :placeholder="t('customerLinks.findBy')" class="min-w-0 flex-1" />
      <UButton type="submit" size="xs" icon="i-lucide-search" :disabled="!formFor(item).value.trim()" :loading="busy === item.integrationId" :aria-label="t('customerLinks.find')" />
    </form>

    <UButton
      v-if="editable && item.status !== 'unresolved'"
      size="xs"
      variant="link"
      color="neutral"
      icon="i-lucide-refresh-cw"
      class="px-0"
      :loading="busy === item.integrationId"
      @click="link(item, {})"
    >
      {{ t('customerLinks.searchAgain') }}
    </UButton>
  </div>
</template>
