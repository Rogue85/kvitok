<script setup lang="ts">
import type { CustomerLinkDto, PendingKind, PendingOption, TicketEventDto } from '@kvitok/shared';

/**
 * Who the customer is, as a decision in the timeline: a customer found by data from the messages (a suggestion),
 * different customers by the contacts and by the messages (a conflict), several candidates, an unconfirmed link.
 * The decision lives on the customer link; once it is taken, the card collapses to a line.
 */
const props = defineProps<{ event: TicketEventDto; link: CustomerLinkDto | null; ticketId: string }>();
const emit = defineEmits<{ changed: [] }>();

const toast = useToast();
const { workspaceId, can } = useWorkspace();
const editable = computed(() => can('operator'));

interface IdentificationEventData {
  integrationId: string;
  integration: string;
  kind: PendingKind;
  identities: Array<{ type: string; value: string; source: string; ruleName: string | null; evidence: string | null }>;
  options: PendingOption[];
}
const data = computed(() => props.event.data as unknown as IdentificationEventData);
/** The card waits for a decision while the link's pending decision is this event. */
const active = computed(() => props.link?.pending?.eventId === props.event.id);
const options = computed(() => props.link?.pending?.options ?? data.value.options ?? []);

const typeLabel = (type: string) => identityLabel(type, props.link?.identityTypes ?? []);
const SOURCES = ['sender', 'api', 'rule', 'manifest', 'agent', 'operator'] as const;
function sourceLabel(item: IdentificationEventData['identities'][number]): string {
  const known = SOURCES.find((s) => s === item.source);
  const label = known ? t(`identification.source.${known}`) : item.source;
  return item.ruleName ? `${label} «${item.ruleName}»` : label;
}

const busy = ref<string | null>(null);
async function decide(body: { decision: 'choose'; customerRef: string } | { decision: 'reject' }): Promise<void> {
  busy.value = body.decision === 'choose' ? body.customerRef : 'reject';
  try {
    await api(`/workspaces/${workspaceId.value}/tickets/${props.ticketId}/customer-links/${data.value.integrationId}/decide`, { method: 'POST', body });
    toast.add({ title: body.decision === 'choose' ? t('identification.card.linked') : t('identification.card.rejected'), icon: 'i-lucide-check' });
    emit('changed');
  } catch (e) {
    toast.add({ color: 'error', title: e instanceof ApiError ? e.message : t('common.actionFailed') });
    emit('changed');
  } finally {
    busy.value = null;
  }
}

const chooseLabel = computed(() => t(`identification.card.choose.${data.value.kind}`));
const rejectLabel = computed(() => t(`identification.card.reject.${data.value.kind}`));
</script>

<template>
  <div v-if="!active" class="flex items-center justify-center gap-1.5 text-xs text-(--ui-text-muted)">
    <UIcon :name="eventIcon(event)" class="size-3.5 shrink-0" />
    <span class="truncate">{{ identificationText(event) }}</span>
    <span class="shrink-0" :title="formatDateTime(event.createdAt)">· {{ formatRelative(event.createdAt) }}</span>
  </div>
  <div v-else class="space-y-2 rounded-md border border-(--ui-warning)/50 bg-(--ui-bg)/80 px-3 py-2.5 text-sm">
    <div class="flex items-center gap-2">
      <UIcon name="i-lucide-user-search" class="size-4 shrink-0 text-(--ui-warning)" />
      <span class="min-w-0 flex-1 truncate font-medium">{{ t(`identification.card.title.${data.kind}`) }}</span>
      <UBadge color="neutral" variant="outline" size="sm">{{ data.integration }}</UBadge>
    </div>

    <ul class="space-y-0.5 text-xs">
      <li v-for="item in data.identities" :key="`${item.type}:${item.value}`">
        <span class="text-(--ui-text-muted)">{{ typeLabel(item.type) }}:</span> <b>{{ item.value }}</b>
        <span class="text-(--ui-text-muted)"> · {{ sourceLabel(item) }}</span>
        <span v-if="item.evidence" class="block italic text-(--ui-text-muted)">«{{ item.evidence }}»</span>
      </li>
    </ul>

    <p v-if="data.kind === 'conflict'" class="text-xs text-(--ui-text-muted)">{{ t('identification.card.conflictHint') }}</p>
    <p v-else-if="data.kind === 'confirm'" class="text-xs text-(--ui-text-muted)">{{ t('identification.card.confirmHint') }}</p>

    <ul class="divide-y divide-(--ui-border) rounded-md border border-(--ui-border)">
      <li v-for="option in options" :key="option.customerRef" class="flex flex-wrap items-center gap-2 px-2.5 py-1.5 text-xs">
        <span class="min-w-0 flex-1">
          <span class="font-medium">{{ option.displayName ?? option.customerRef }}</span>
          <span v-if="option.hint" class="text-(--ui-text-muted)"> · {{ option.hint }}</span>
          <span class="mt-0.5 flex flex-wrap gap-1">
            <UBadge v-if="option.current" color="info" variant="subtle" size="sm">{{ t('identification.card.current') }}</UBadge>
            <UBadge v-for="type in option.matchedBy" :key="type" color="neutral" variant="outline" size="sm">{{ t('identification.card.matchedBy', { type: typeLabel(type) }) }}</UBadge>
          </span>
        </span>
        <UButton
          v-if="editable"
          size="xs"
          :variant="options.length === 1 ? 'solid' : 'soft'"
          icon="i-lucide-check"
          :loading="busy === option.customerRef"
          :disabled="busy !== null"
          @click="decide({ decision: 'choose', customerRef: option.customerRef })"
        >
          {{ chooseLabel }}
        </UButton>
      </li>
    </ul>

    <UButton v-if="editable" size="xs" color="neutral" variant="ghost" :loading="busy === 'reject'" :disabled="busy !== null" @click="decide({ decision: 'reject' })">
      {{ rejectLabel }}
    </UButton>
  </div>
</template>
