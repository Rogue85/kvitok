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

definePageMeta({ hideTabBar: true });

const route = useRoute();
const toast = useToast();
const { workspaceId, can, canSee } = useWorkspace();
const { departmentById, memberById, fields } = useWorkspaceData();
const { me } = useAuth();
const { data: workspace } = await useWorkspaceSettings();
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
/** The ticket left the user's sight: why, shown instead of the ticket. */
const movedAway = ref<string | null>(null);
watch(ticketId, () => (movedAway.value = null));
function departmentTitle(departmentId: string | null): string {
  return departmentId ? (departmentById.value.get(departmentId)?.title ?? t('events.deletedDepartment')) : t('events.noDepartment');
}
/**
 * Access may have changed: a move, a change of assignees or of the user's departments. An assignee may still see a ticket
 * outside their departments, so the API decides: a ticket it hides is gone from this page.
 */
async function recheck(movedTo?: string | null): Promise<void> {
  try {
    await api<TicketDto>(base.value);
  } catch (error) {
    if (toApiError(error).status !== 404) return;
    const department = movedTo !== undefined ? movedTo : (ticket.value?.departmentId ?? null);
    movedAway.value = canSee(department) ? t('ticket.accessLost') : t('ticket.movedAway', { department: departmentTitle(department) });
    return;
  }
  refreshAll();
}
useRealtime((event) => {
  if (event.type === 'access.changed') {
    void recheck();
    return;
  }
  if (event.ticketId !== ticketId.value) return;
  if (event.type === 'ticket.moved' || event.type === 'ticket.access') {
    void recheck(event.type === 'ticket.moved' ? event.to : undefined);
    return;
  }
  refreshAll();
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

/** A move to a department the user cannot see, waiting for confirmation. */
const pendingMove = ref<UpdateTicketInput | null>(null);

function confirmMove(): void {
  const patch = pendingMove.value!;
  pendingMove.value = null;
  void update(patch, true);
}

/**
 * The user keeps the ticket after a move to a department they cannot see: they are its assignee, not a distributor's
 * untouched pick (that one leaves with the move), and the workspace lets assignees keep tickets of other departments.
 */
const keepsAsAssignee = computed(
  () =>
    (workspace.value?.assignment.assigneesKeepAccess ?? false) &&
    (ticket.value?.assignees.some((a) => a.id === me.value?.user.id && (a.source !== 'auto' || a.actedAt !== null)) ?? false),
);

async function update(patch: UpdateTicketInput, confirmed = false): Promise<void> {
  if (patch.departmentId !== undefined && !canSee(patch.departmentId) && !keepsAsAssignee.value && !confirmed) {
    pendingMove.value = patch;
    return;
  }
  try {
    ticket.value = await api<TicketDto>(base.value, { method: 'PATCH', body: patch });
    // An assignee keeps a ticket of another department while the workspace allows it; the answer already says whether they stayed.
    if (!canSee(ticket.value.departmentId) && !ticket.value.assignees.some((a) => a.id === me.value?.user.id)) {
      toast.add({ color: 'success', title: t('ticket.movedAway', { department: departmentTitle(ticket.value.departmentId) }) });
      await navigateTo(`/w/${workspaceId.value}/tickets`);
      return;
    }
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

/* Properties on the right — collapsible, the choice is remembered; on phones a sheet, closed until asked for */
const mobile = useMobile();
const sheetOpen = ref(false);
const propsOpen = ref(true);
onMounted(() => {
  try {
    propsOpen.value = localStorage.getItem('ticket:props-open') !== '0';
  } catch {
    // without localStorage the panel just stays open
  }
});
function toggleProps(): void {
  if (mobile.value) {
    sheetOpen.value = !sheetOpen.value;
    return;
  }
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
          <span v-if="ticket" class="flex min-w-0 flex-col truncate lg:block">
            <span class="text-xs font-normal text-(--ui-text-muted) lg:text-base lg:font-semibold">T-{{ ticket.number }}<span class="max-lg:hidden"> · </span></span>
            <span class="truncate text-sm lg:text-base">{{ ticket.subject }}</span>
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
            class="w-32 lg:w-40"
            @update:model-value="update({ status: $event as TicketStatus })"
          />
          <UTooltip :text="propsOpen && !mobile ? t('ticket.hideProperties') : t('ticket.showProperties')">
            <UButton
              :icon="propsOpen && !mobile ? 'i-lucide-panel-right-close' : 'i-lucide-panel-right-open'"
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
      <UAlert v-if="movedAway !== null" color="warning" variant="subtle" :title="movedAway" class="m-4 w-auto" />
      <UAlert v-else-if="error" color="error" variant="subtle" :title="t('ticket.notFound')" class="m-4 w-auto" />
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

        <USlideover v-if="mobile" v-model:open="sheetOpen" :title="t('ticket.properties')" :ui="{ content: 'max-w-md pt-[env(safe-area-inset-top)]', body: 'pb-[calc(1rem+env(safe-area-inset-bottom))]' }">
          <template #body>
            <TicketSidebar :ticket="ticket" :links="links" :cost="agent?.cost ?? null" @update="update" @changed="refreshAll" @open-runs="openRun(null)" />
          </template>
        </USlideover>
        <aside v-else-if="propsOpen" class="w-80 shrink-0 overflow-y-auto border-l border-(--ui-border) p-6">
          <TicketSidebar :ticket="ticket" :links="links" :cost="agent?.cost ?? null" @update="update" @changed="refreshAll" @open-runs="openRun(null)" />
        </aside>
        <AgentRunsModal v-if="agent" v-model:open="runsOpen" :runs="agent.runs" :run-id="runId" :currency="agent.cost.currency" />
      </div>

      <UModal
        :open="pendingMove !== null"
        :title="t('ticket.moveOut.title')"
        :description="t('ticket.moveOut.body', { department: departmentTitle(pendingMove?.departmentId ?? null) })"
        @update:open="(open: boolean) => !open && (pendingMove = null)"
      >
        <template #footer>
          <UButton color="neutral" variant="ghost" @click="pendingMove = null">{{ t('common.cancel') }}</UButton>
          <UButton color="warning" @click="confirmMove">{{ t('ticket.moveOut.confirm') }}</UButton>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
