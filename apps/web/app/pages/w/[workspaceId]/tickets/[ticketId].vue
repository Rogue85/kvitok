<script setup lang="ts">
import {
  TICKET_STATUSES,
  type AgentAnalyzedEventData,
  type CustomerLinkDto,
  type MessageDto,
  type TicketAgentDto,
  type TicketDto,
  type TicketEventDto,
  type TicketStatus,
  type TimelineItemDto,
  type UpdateTicketInput,
} from '@kvitok/shared';

const route = useRoute();
const toast = useToast();
const { workspaceId, can } = useWorkspace();
const { departmentById, memberById, fields } = useWorkspaceData();
const ticketId = computed(() => String(route.params.ticketId));
const base = computed(() => `/workspaces/${workspaceId.value}/tickets/${ticketId.value}`);

const { data: ticket, refresh: refreshTicket, error } = await useAsyncData(
  () => `ticket:${ticketId.value}`,
  () => api<TicketDto>(base.value),
  { watch: [ticketId] },
);
const { data: timeline, refresh: refreshTimeline } = await useAsyncData(
  () => `timeline:${ticketId.value}`,
  () => api<TimelineItemDto[]>(`${base.value}/timeline`),
  { watch: [ticketId], default: () => [] },
);

const { data: agent, refresh: refreshAgent } = await useAsyncData(
  () => `ticket-agent:${ticketId.value}`,
  () => api<TicketAgentDto>(`${base.value}/agent`),
  { watch: [ticketId] },
);
/** The customer in integrations: the sidebar, the identification cards, locked actions and the reply warning. */
const { data: links, refresh: refreshLinks } = await useAsyncData(
  () => `customer-links:${ticketId.value}`,
  () => api<CustomerLinkDto[]>(`${base.value}/customer-links`).catch(() => []),
  { watch: [ticketId], default: () => [] },
);
const runsOpen = ref(false);
const runId = ref<string | null>(null);
function openRun(id: string | null): void {
  runId.value = id;
  runsOpen.value = true;
}

const refreshAll = debounce(() => {
  void refreshTicket();
  void refreshTimeline();
  void refreshAgent();
  void refreshLinks();
}, 300);
useRealtime((event) => {
  if (event.ticketId === ticketId.value) refreshAll();
});

const lookups = computed(() => ({
  departments: departmentById.value,
  members: memberById.value,
  fields: new Map(fields.data.value.filter((f) => f.entity === 'ticket').map((f) => [f.key, f])),
}));

const lastSeenMessageId = computed(() => {
  const messages = timeline.value.filter((i) => i.kind === 'message');
  const last = messages[messages.length - 1];
  return last && last.kind === 'message' ? last.message.id : null;
});

const AGENT_EVENTS = new Set(['agent_analyzed', 'agent_failed']);
/** Identification events that asked the operator a question: shown as a card while the decision is open. */
const IDENTIFICATION_CARDS = new Set(['suggestion', 'conflict', 'candidates', 'confirm']);
function isIdentificationCard(event: { type: string; data: Record<string, unknown> }): boolean {
  return event.type === 'customer_identification' && IDENTIFICATION_CARDS.has(String(event.data.kind));
}
function linkOf(event: { data: Record<string, unknown> }): CustomerLinkDto | null {
  return links.value.find((l) => l.integrationId === event.data.integrationId) ?? null;
}
/** The timeline with runs of plain events between messages and cards merged; failures and status changes stay apart. */
type TimelineEntry = TimelineItemDto | { kind: 'events'; events: TicketEventDto[] };
const entries = computed(() => {
  const result: TimelineEntry[] = [];
  for (const item of timeline.value) {
    if (item.kind === 'message' || isIdentificationCard(item.event) || AGENT_EVENTS.has(item.event.type)) {
      result.push(item);
      continue;
    }
    const last = result[result.length - 1];
    if (last?.kind === 'events' && !isStandaloneEvent(item.event) && !isStandaloneEvent(last.events[0]!)) last.events.push(item.event);
    else result.push({ kind: 'events', events: [item.event] });
  }
  return result;
});
function entryKey(entry: TimelineEntry): string {
  if (entry.kind === 'message') return entry.message.id;
  return entry.kind === 'event' ? entry.event.id : entry.events[0]!.id;
}
/** Id of the last agent message — it carries the suggestions and the draft button. */
const latestAgentEventId = computed(() => {
  for (let i = timeline.value.length - 1; i >= 0; i--) {
    const item = timeline.value[i]!;
    if (item.kind === 'event' && AGENT_EVENTS.has(item.event.type)) return item.event.id;
  }
  return null;
});
/** Texts of the agent's questions — to label the answers to them. */
const questionTexts = computed(() => {
  const texts = new Map<string, string>();
  for (const item of timeline.value) {
    if (item.kind === 'event' && item.event.type === 'agent_analyzed') {
      for (const q of (item.event.data as unknown as AgentAnalyzedEventData).questions ?? []) texts.set(q.id, q.text);
    }
  }
  return texts;
});
function isAgentChat(message: MessageDto): boolean {
  return message.visibility === 'internal' && message.authorType === 'operator';
}

const statusItems = TICKET_STATUSES.map((value) => ({ label: statusLabel(value), value }));

async function update(patch: UpdateTicketInput): Promise<void> {
  try {
    ticket.value = await api<TicketDto>(base.value, { method: 'PATCH', body: patch });
    void refreshTimeline();
  } catch (e) {
    const details = e instanceof ApiError && Array.isArray(e.details) ? (e.details as Array<{ message: string }>).map((d) => d.message).join('; ') : '';
    toast.add({ color: 'error', title: e instanceof ApiError ? e.message : t('ticket.saveFailed'), description: details || undefined });
    void refreshTicket();
  }
}

/* Agent */
const AGENT_STATE: Record<string, { label: string; color: 'neutral' | 'info' | 'error' | 'success'; icon: string }> = {
  idle: { label: t('ticket.agentState.idle'), color: 'success', icon: 'i-lucide-sparkles' },
  queued: { label: t('ticket.agentState.queued'), color: 'info', icon: 'i-lucide-clock' },
  running: { label: t('ticket.agentState.running'), color: 'info', icon: 'i-lucide-loader-circle' },
  failed: { label: t('ticket.agentState.failed'), color: 'error', icon: 'i-lucide-triangle-alert' },
};
const agentBusy = computed(() => agent.value?.state === 'running' || agent.value?.state === 'queued');
const agentState = computed(() => (agent.value?.enabled ? (AGENT_STATE[agent.value.state] ?? AGENT_STATE.idle!) : null));
async function rerunAgent(): Promise<void> {
  try {
    await api(`${base.value}/agent/run`, { method: 'POST', body: { mode: 'refine' } });
    toast.add({ title: t('ticket.rerunStarted'), icon: 'i-lucide-check' });
    refreshAll();
  } catch (e) {
    toast.add({ color: 'error', title: e instanceof ApiError ? e.message : t('common.actionFailed') });
  }
}
const agentMenu = computed(() => [
  ...(can('operator') && agent.value?.enabled ? [{ label: t('ticket.rerun'), icon: 'i-lucide-refresh-cw', disabled: agentBusy.value, onSelect: rerunAgent }] : []),
  { label: t('ticket.agentRuns'), icon: 'i-lucide-history', disabled: !agent.value?.runs.length, onSelect: () => openRun(null) },
]);

/* Reply to the customer — a card at the end of the timeline */
const composer = ref<{ cancel: (messageId: string, draft: string) => Promise<void>; flush: () => Promise<void> } | null>(null);
const replyOpen = ref(false);
watch(
  ticketId,
  () => {
    // The operator's own unsent edits — open the reply right away.
    replyOpen.value = agent.value?.draft?.source === 'operator';
  },
  { immediate: true },
);
async function openReply(): Promise<void> {
  replyOpen.value = true;
  await nextTick();
  scrollToBottom();
}
async function flushDraft(): Promise<void> {
  await composer.value?.flush();
}
function onSent(_message: MessageDto): void {
  replyOpen.value = false;
  refreshAll();
}
async function cancelFromTimeline(messageId: string): Promise<void> {
  const item = timeline.value.find((i) => i.kind === 'message' && i.message.id === messageId);
  replyOpen.value = true;
  await nextTick();
  await composer.value?.cancel(messageId, item?.kind === 'message' ? (item.message.bodyHtml ?? '') : '');
  refreshAll();
}

const replyTo = ref<{ id: string; text: string } | null>(null);

/* Properties on the right — collapsible, the choice is remembered */
const propsOpen = ref(true);
onMounted(() => {
  try {
    propsOpen.value = localStorage.getItem('ticket:props-open') !== '0';
  } catch {
    // without localStorage the panel just stays open
  }
});
function toggleProps(): void {
  propsOpen.value = !propsOpen.value;
  try {
    localStorage.setItem('ticket:props-open', propsOpen.value ? '1' : '0');
  } catch {
    // not critical
  }
}

const scroller = ref<HTMLElement | null>(null);
function scrollToBottom(): void {
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: 'smooth' });
}
watch(
  () => [timeline.value.length, agentBusy.value],
  async () => {
    await nextTick();
    scrollToBottom();
  },
);
</script>

<template>
  <UDashboardPanel id="ticket" :ui="{ body: 'p-0 sm:p-0 overflow-hidden' }">
    <template #header>
      <UDashboardNavbar>
        <template #leading>
          <UButton icon="i-lucide-arrow-left" color="neutral" variant="ghost" :to="`/w/${workspaceId}/tickets`" :aria-label="t('ticket.backToList')" />
        </template>
        <template #title>
          <span v-if="ticket" class="truncate">
            <span class="text-(--ui-text-muted)">T-{{ ticket.number }}</span> · {{ ticket.subject }}
          </span>
        </template>
        <template #right>
          <UDropdownMenu v-if="agent" :items="agentMenu" :content="{ align: 'end' }">
            <UButton color="neutral" variant="ghost" size="sm" :aria-label="agentState?.label ?? t('ticket.agentState.off')">
              <UIcon
                :name="agentState?.icon ?? 'i-lucide-bot-off'"
                class="size-4"
                :class="[agent.state === 'running' ? 'animate-spin' : '', agentState?.color === 'error' ? 'text-(--ui-error)' : '']"
              />
              <span class="hidden text-xs sm:inline">{{ agentState?.label ?? t('ticket.agentState.off') }}</span>
            </UButton>
          </UDropdownMenu>
          <USelect
            v-if="ticket"
            :model-value="ticket.status"
            :items="statusItems"
            :disabled="!can('operator')"
            class="w-40"
            @update:model-value="update({ status: $event as TicketStatus })"
          />
          <UTooltip :text="propsOpen ? t('ticket.hideProperties') : t('ticket.showProperties')">
            <UButton
              :icon="propsOpen ? 'i-lucide-panel-right-close' : 'i-lucide-panel-right-open'"
              color="neutral"
              variant="ghost"
              :aria-label="t('ticket.properties')"
              @click="toggleProps"
            />
          </UTooltip>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UAlert v-if="error" color="error" variant="subtle" :title="t('ticket.notFound')" class="m-4 w-auto" />
      <div v-else-if="ticket" class="flex h-full min-h-0">
        <div class="flex min-w-0 flex-1 flex-col">
          <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto px-4 py-6">
            <div class="mx-auto max-w-3xl space-y-4">
              <template v-for="item in entries" :key="entryKey(item)">
                <TicketEventGroup v-if="item.kind === 'events'" :events="item.events" :lookups="lookups" />
                <template v-else-if="item.kind === 'message'">
                  <div v-if="isAgentChat(item.message)" class="ml-auto w-fit max-w-[80%]">
                    <div class="rounded-2xl rounded-br-md bg-(--ui-bg-elevated) px-3.5 py-2 text-sm">
                      <p v-if="item.message.answersQuestionId" class="mb-1 flex items-center gap-1 text-xs text-(--ui-text-muted)">
                        <UIcon name="i-lucide-corner-down-right" class="size-3" />
                        {{ questionTexts.get(item.message.answersQuestionId) ?? t('ticket.answerToAgent') }}
                      </p>
                      <p class="whitespace-pre-wrap">{{ item.message.bodyText }}</p>
                    </div>
                    <p class="mt-0.5 text-right text-xs text-(--ui-text-muted)" :title="formatDateTime(item.message.createdAt)">
                      {{ t('ticket.toAgent', { author: item.message.author?.name ?? t('ticket.operator'), time: formatRelative(item.message.createdAt) }) }}
                    </p>
                  </div>
                  <TicketMessageCard v-else :message="item.message" :workspace-id="workspaceId" @cancel="cancelFromTimeline" />
                </template>
                <TicketIdentificationCard
                  v-else-if="isIdentificationCard(item.event)"
                  :id="`event-${item.event.id}`"
                  :event="item.event"
                  :link="linkOf(item.event)"
                  :ticket-id="ticket.id"
                  @changed="refreshAll"
                />
                <AgentMessage
                  v-else
                  :event="item.event"
                  :ticket="ticket"
                  :agent="agent ?? null"
                  :links="links"
                  :latest="item.event.id === latestAgentEventId"
                  @answer="replyTo = $event"
                  @open-draft="openReply"
                  @open-run="openRun"
                  @changed="refreshAll"
                />
              </template>

              <div v-if="agentBusy" class="flex items-center gap-3 text-sm text-(--ui-text-muted)">
                <div class="flex size-7 items-center justify-center rounded-full bg-(--ui-primary)/10 text-(--ui-primary)">
                  <UIcon name="i-lucide-sparkles" class="size-4" />
                </div>
                <UChatShimmer :text="t('ticket.agentState.running')" />
              </div>

              <TicketReplyComposer
                v-if="can('operator') && replyOpen"
                ref="composer"
                :ticket="ticket"
                :last-seen-message-id="lastSeenMessageId"
                :agent="agent ?? null"
                :links="links"
                @sent="onSent"
                @changed="refreshAll"
                @close="replyOpen = false"
              />
            </div>
          </div>

          <div v-if="can('operator')" class="mx-auto w-full max-w-3xl px-4 pb-4">
            <AgentChatInput
              v-model:reply-to="replyTo"
              :ticket="ticket"
              :agent="agent ?? null"
              :reply-open="replyOpen"
              :before-send="flushDraft"
              @sent="refreshAll"
              @reply="openReply"
            />
          </div>
        </div>

        <aside v-if="propsOpen" class="w-80 shrink-0 overflow-y-auto border-l border-(--ui-border) p-6">
          <TicketSidebar :ticket="ticket" :links="links" :cost="agent?.cost ?? null" @update="update" @changed="refreshAll" @open-runs="openRun(null)" />
        </aside>
        <AgentRunsModal v-if="agent" v-model:open="runsOpen" :runs="agent.runs" :run-id="runId" :currency="agent.cost.currency" />
      </div>
    </template>
  </UDashboardPanel>
</template>
