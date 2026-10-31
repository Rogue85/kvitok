<script setup lang="ts">
import type { ClaimStatus, CustomerLinkDto, IdentityClaimDto, TicketDto } from '@kvitok/shared';

/**
 * The customer in external systems (integrations): found or not, unconfirmed, a decision waiting in the timeline,
 * the identities found in the ticket's messages, candidates, manual search and choice.
 */
const props = defineProps<{ ticket: TicketDto; links: CustomerLinkDto[] }>();
const emit = defineEmits<{ changed: [] }>();
const toast = useToast();
const { workspaceId, can } = useWorkspace();
const editable = computed(() => can('operator'));
const base = computed(() => `/workspaces/${workspaceId.value}/tickets/${props.ticket.id}/customer-links`);

const STATUS_COLORS: Record<CustomerLinkDto['status'], 'success' | 'warning' | 'neutral' | 'info'> = {
  found: 'success',
  ambiguous: 'warning',
  not_found: 'neutral',
  unresolved: 'info',
};
const CLAIM_COLORS: Record<ClaimStatus, 'success' | 'warning' | 'neutral' | 'info' | 'error'> = {
  pending: 'info',
  matched: 'warning',
  not_found: 'neutral',
  confirmed: 'success',
  rejected: 'neutral',
};
const CLAIM_SOURCES = ['sender', 'api', 'rule', 'manifest', 'agent', 'operator'] as const;
function claimSource(claim: IdentityClaimDto): string {
  const known = CLAIM_SOURCES.find((s) => s === claim.source);
  const label = known ? t(`identification.source.${known}`) : claim.source;
  return claim.ruleName ? `${label} «${claim.ruleName}»` : label;
}

const search = reactive<Record<string, { type: string; value: string }>>({});
const formFor = (link: CustomerLinkDto) => (search[link.integrationId] ??= { type: link.identityTypes[0]?.type ?? 'phone', value: '' });
const busy = ref<string | null>(null);

async function link(target: CustomerLinkDto, body: Record<string, unknown>): Promise<void> {
  busy.value = target.integrationId;
  try {
    const result = await api<{ outcome: 'found' | 'not_found' | 'ambiguous'; link: CustomerLinkDto }>(`${base.value}/${target.integrationId}`, { method: 'POST', body });
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
    emit('changed');
  }
}

/** The pending card is in the timeline: scroll to it. */
function showDecision(eventId: string): void {
  document.getElementById(`event-${eventId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
</script>

<template>
  <div v-for="item in links" :key="item.integrationId" class="space-y-2 rounded-md border border-(--ui-border) p-2.5 text-sm">
    <div class="flex items-center gap-2">
      <UIcon name="i-lucide-plug" class="shrink-0 text-(--ui-text-muted)" />
      <span class="min-w-0 flex-1 truncate font-medium">{{ item.integrationName }}</span>
      <UBadge v-if="item.status === 'found' && !item.confirmed" color="warning" variant="subtle" size="sm">{{ t('customerLinks.unconfirmed') }}</UBadge>
      <UBadge v-else :color="STATUS_COLORS[item.status]" variant="subtle" size="sm">{{ t(`customerLinks.status.${item.status}`) }}</UBadge>
    </div>

    <p v-if="item.status === 'found'" class="text-(--ui-text-muted)">
      {{ item.displayName ?? t('ticket.sidebar.noName') }} · <code class="text-xs">{{ item.customerRef }}</code>
      <span v-if="item.source === 'manual'"> · {{ t('customerLinks.linkedByOperator') }}</span>
      <span v-else-if="item.source === 'claim'"> · {{ t('customerLinks.linkedByMessages', { types: item.matchedBy.map((type) => identityLabel(type, item.identityTypes)).join(', ') }) }}</span>
    </p>
    <p v-else-if="item.status === 'unresolved'" class="text-(--ui-text-muted)">{{ t('customerLinks.agentWillFind') }}</p>
    <p v-if="item.lastError" class="text-xs text-(--ui-error)">{{ item.lastError }}</p>

    <button
      v-if="item.pending"
      type="button"
      class="flex w-full items-center gap-1.5 rounded-md bg-(--ui-warning)/10 px-2 py-1 text-left text-xs text-(--ui-warning) hover:bg-(--ui-warning)/15"
      @click="showDecision(item.pending.eventId)"
    >
      <UIcon name="i-lucide-user-search" class="size-3.5 shrink-0" />
      <span class="flex-1">{{ t(`customerLinks.pending.${item.pending.kind}`) }}</span>
      <UIcon name="i-lucide-arrow-down" class="size-3.5 shrink-0" />
    </button>

    <div v-if="item.claims.length" class="space-y-1">
      <p class="text-xs text-(--ui-text-muted)">{{ t('customerLinks.claims') }}</p>
      <ul class="space-y-1 text-xs">
        <li v-for="claim in item.claims" :key="claim.id" class="flex items-start gap-1.5">
          <span class="min-w-0 flex-1">
            {{ identityLabel(claim.type, item.identityTypes) }}: <b>{{ claim.value }}</b>
            <span class="block text-(--ui-text-muted)">{{ claimSource(claim) }}</span>
          </span>
          <UBadge :color="CLAIM_COLORS[claim.status]" variant="subtle" size="sm" class="shrink-0">{{ t(`identification.claimStatus.${claim.status}`) }}</UBadge>
        </li>
      </ul>
    </div>

    <ul v-if="item.status === 'ambiguous' && !item.pending" class="space-y-1">
      <li v-for="candidate in item.candidates" :key="candidate.customerRef" class="flex items-center gap-2">
        <span class="min-w-0 flex-1 truncate">{{ candidate.displayName }}<span v-if="candidate.hint" class="text-(--ui-text-muted)"> · {{ candidate.hint }}</span></span>
        <UButton v-if="editable" size="xs" variant="outline" :loading="busy === item.integrationId" @click="link(item, { customerRef: candidate.customerRef })">{{ t('customerLinks.choose') }}</UButton>
      </li>
    </ul>

    <form v-if="editable && item.status !== 'found'" class="flex gap-1" @submit.prevent="link(item, { identities: { [formFor(item).type]: formFor(item).value } })">
      <USelect
        v-model="formFor(item).type"
        :items="item.identityTypes.map((identity) => ({ label: identityLabel(identity.type, item.identityTypes), value: identity.type }))"
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
