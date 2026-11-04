<script setup lang="ts">
import type { AgentAnalyzedEventData, CustomerLinkDto, FieldSuggestion, TicketAgentDto, TicketDto, TicketEventDto } from '@kvitok/shared';

/** An agent message in the ticket timeline: reply to the operator, analysis, questions and (on the latest analysis) suggestions. */
const props = defineProps<{ event: TicketEventDto; ticket: TicketDto; agent: TicketAgentDto | null; latest: boolean; links?: CustomerLinkDto[] }>();
const emit = defineEmits<{ answer: [question: { id: string; text: string }]; openDraft: []; openRun: [runId: string]; changed: [] }>();

const toast = useToast();
const { workspaceId, can } = useWorkspace();
const { departmentById, ticketFields } = useWorkspaceData();
const base = computed(() => `/workspaces/${workspaceId.value}/tickets/${props.ticket.id}/agent`);
const editable = computed(() => can('operator'));

const failed = computed(() => props.event.type === 'agent_failed');
const data = computed(() => props.event.data as unknown as AgentAnalyzedEventData & { error?: string });
const message = computed(() => data.value.message?.trim() ?? '');
/** The current ticket analysis, if this run created it. */
const current = computed(() => (props.agent?.analysis?.runId === data.value.runId ? props.agent.analysis : null));
/** Older events have no summary or findings — take them from the current analysis if it belongs to this run. */
const summary = computed(() => data.value.summary ?? current.value?.summary ?? '');
const findings = computed(() => data.value.findings ?? current.value?.findings ?? []);
const questions = computed(() => (Array.isArray(data.value.questions) ? data.value.questions : []));
/** Actions proposed by this run, with their current status. */
const actions = computed(() => (data.value.runId ? (props.agent?.actions.filter((a) => a.runId === data.value.runId) ?? []) : []));
/** A partial run that did not touch the analysis shows only the reply to the operator. */
const showAnalysis = computed(() => !failed.value && data.value.analysisUpdated !== false);
/** A run with nothing to say to the operator (customer email, older events) is not a message but an "agent updated the analysis" line. */
const compact = computed(() => !failed.value && !message.value && !props.latest && questions.value.length === 0 && actions.value.length === 0);
/** A partial run that neither said nor changed anything is not needed in the timeline. */
const empty = computed(() => compact.value && !showAnalysis.value && !data.value.replyUpdated);
/** The analysis is collapsed: the reply to the operator already says the essentials. Without a reply, the latest message shows it anyway. */
const expanded = ref(false);

const departmentTitle = computed(() => {
  const key = data.value.department;
  return key ? ([...departmentById.value.values()].find((d) => d.key === key)?.title ?? key) : t('events.undetermined');
});
const openQuestionIds = computed(() => new Set(props.agent?.questions.map((q) => q.id) ?? []));
/** Suggestions live in the current ticket analysis — show them only on the latest message that created it. */
const analysis = computed(() => (props.latest ? current.value : null));
const hasSuggestions = computed(() => Boolean(analysis.value?.departmentSuggestion) || Object.keys(analysis.value?.fieldSuggestions ?? {}).length > 0);

const SUGGESTION_REASONS = ['suggest_mode', 'low_confidence', 'locked', 'filled_by_other_source', 'ambiguous'] as const;
function suggestionReason(reason: string): string {
  const known = SUGGESTION_REASONS.find((r) => r === reason);
  return known ? t(`agentMessage.suggestionReason.${known}`) : reason;
}
function fieldLabel(key: string): string {
  return ticketFields.value.find((f) => f.key === key)?.label ?? key;
}
function fieldOptions(key: string) {
  return ticketFields.value.find((f) => f.key === key)?.options ?? [];
}
/** A candidate chip: the label and the group, so "Arbat" in two cities can be told apart. */
function optionTitle(key: string, value: unknown): string {
  const option = fieldOptions(key).find((o) => o.value === value);
  return option ? [option.label, option.group].filter(Boolean).join(' · ') : String(value);
}
/** The suggested value first, then the other candidates. */
function choices(suggestion: FieldSuggestion): string[] {
  return [suggestion.value, ...(suggestion.candidates ?? [])].filter((v): v is string => typeof v === 'string' && v !== '');
}

async function call(path: string, body: object = {}, success?: string): Promise<void> {
  try {
    await api(`${base.value}/${path}`, { method: 'POST', body });
    if (success) toast.add({ title: success, icon: 'i-lucide-check' });
    emit('changed');
  } catch (error) {
    toast.add({ color: 'error', title: error instanceof ApiError ? error.message : t('common.actionFailed') });
  }
}
</script>

<template>
  <div v-if="empty" class="hidden" />
  <div v-else-if="compact" class="group text-xs text-(--ui-text-muted)">
    <div class="flex items-center gap-1.5">
      <button type="button" class="flex min-w-0 items-center gap-1.5 hover:text-(--ui-text)" @click="expanded = !expanded">
        <UIcon name="i-lucide-sparkles" class="size-3.5 shrink-0 text-violet-500" />
        <span class="truncate">
          {{ data.mode === 'triage' ? t('agentMessage.analyzed') : t('agentMessage.updated') }}<template v-if="showAnalysis">: {{ departmentTitle }}, {{ Math.round(data.confidence * 100) }}%</template><template v-if="data.replyUpdated">, {{ t('agentMessage.newDraft') }}</template>
        </span>
        <UIcon :name="expanded ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-3.5 shrink-0" />
      </button>
      <span class="shrink-0" :title="formatDateTime(event.createdAt)">· {{ formatRelative(event.createdAt) }}</span>
      <UButton
        v-if="data.runId"
        class="ml-auto opacity-0 transition-opacity group-hover:opacity-100"
        size="xs"
        color="neutral"
        variant="link"
        :padded="false"
        @click="emit('openRun', data.runId)"
      >
        {{ t('agentMessage.runDetails') }}
      </UButton>
    </div>
    <div v-if="expanded && summary" class="mt-1 space-y-1 pl-5 text-sm text-(--ui-text)">
      <p>{{ summary }}</p>
      <ul v-if="findings.length" class="list-disc space-y-0.5 pl-4 text-xs text-(--ui-text-muted)">
        <li v-for="finding in findings" :key="finding">{{ finding }}</li>
      </ul>
    </div>
  </div>
  <div v-else class="group flex items-start gap-3" :class="failed ? '' : 'ai-card px-3.5 py-3'">
    <div
      class="flex size-7 shrink-0 items-center justify-center rounded-full"
      :class="failed ? 'bg-(--ui-error)/10 text-(--ui-error)' : 'ai-orb'"
    >
      <UIcon :name="failed ? 'i-lucide-bot-off' : 'i-lucide-sparkles'" class="size-4" />
    </div>

    <div class="min-w-0 flex-1 space-y-2 text-sm">
      <div class="flex items-center gap-2 text-xs text-(--ui-text-muted)">
        <span class="font-semibold" :class="failed ? 'text-(--ui-text)' : 'ai-text'">{{ t('nav.agent') }}</span>
        <span :title="formatDateTime(event.createdAt)">· {{ formatRelative(event.createdAt) }}</span>
        <UButton
          v-if="data.runId"
          class="ml-auto opacity-0 transition-opacity group-hover:opacity-100"
          size="xs"
          color="neutral"
          variant="link"
          :padded="false"
          @click="emit('openRun', data.runId)"
        >
          {{ t('agentMessage.runDetails') }}
        </UButton>
      </div>

      <p v-if="failed" class="text-(--ui-error)">{{ t('agentMessage.failed', { error: data.error ?? '' }) }}</p>
      <p v-if="message" class="whitespace-pre-wrap">{{ message }}</p>

      <div v-if="showAnalysis" class="space-y-1">
        <button
          v-if="message || !latest"
          type="button"
          class="flex items-center gap-1 text-xs text-(--ui-text-muted) hover:text-(--ui-text)"
          @click="expanded = !expanded"
        >
          <UIcon :name="expanded ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-3.5" />
          {{ t('agentMessage.analysis', { department: departmentTitle, percent: Math.round(data.confidence * 100) }) }}
        </button>
        <div v-if="expanded || (!message && latest)" class="space-y-1">
          <p v-if="summary">{{ summary }}</p>
          <ul v-if="findings.length" class="list-disc space-y-0.5 pl-4 text-xs text-(--ui-text-muted)">
            <li v-for="finding in findings" :key="finding">{{ finding }}</li>
          </ul>
          <div class="flex flex-wrap items-center gap-1 text-xs">
            <span class="text-(--ui-text-muted)">{{ t('agentMessage.departmentLabel') }}</span>
            <span class="font-medium">{{ departmentTitle }}</span>
            <UBadge :color="data.confidence >= 0.6 ? 'success' : 'warning'" variant="subtle" size="sm">{{ Math.round(data.confidence * 100) }}%</UBadge>
            <UBadge v-if="data.needsHuman" color="warning" variant="subtle" size="sm">{{ t('agentMessage.needsHuman') }}</UBadge>
            <UBadge v-if="data.sentToTriage" color="info" variant="subtle" size="sm">{{ t('agentMessage.sentToTriage') }}</UBadge>
          </div>
        </div>
      </div>

      <div v-if="hasSuggestions && analysis" class="space-y-1.5">
        <div v-if="analysis.departmentSuggestion" class="flex flex-wrap items-center gap-2 rounded-md border border-(--ui-border) bg-(--ui-bg)/70 px-2.5 py-1.5 text-xs">
          <span>
            {{ t('agentMessage.departmentSuggestion') }} <b>{{ departmentById.get(analysis.departmentSuggestion.departmentId)?.title ?? '—' }}</b>
            <span class="text-(--ui-text-muted)"> · {{ Math.round(analysis.departmentSuggestion.confidence * 100) }}%<template v-if="analysis.departmentSuggestion.reason">, {{ analysis.departmentSuggestion.reason }}</template></span>
          </span>
          <span v-if="editable" class="ml-auto flex gap-1">
            <UButton size="xs" variant="soft" @click="call('suggestions/accept', { kind: 'department' }, t('agentMessage.departmentChanged'))">{{ t('agentMessage.accept') }}</UButton>
            <UButton size="xs" color="neutral" variant="ghost" @click="call('suggestions/reject', { kind: 'department' })">{{ t('action.reject') }}</UButton>
          </span>
        </div>
        <div
          v-for="(suggestion, key) in analysis.fieldSuggestions"
          :key="key"
          class="flex flex-wrap items-center gap-2 rounded-md border border-(--ui-border) bg-(--ui-bg)/70 px-2.5 py-1.5 text-xs"
        >
          <template v-if="suggestion.candidates?.length">
            <!-- Several options fit: the operator picks one with a click. -->
            <span class="min-w-0 basis-full">
              {{ fieldLabel(String(key)) }}: <b>{{ t('agentMessage.severalFit') }}</b>
              <span class="text-(--ui-text-muted)"> · {{ Math.round(suggestion.confidence * 100) }}%</span>
              <span v-if="suggestion.evidence" class="block italic text-(--ui-text-muted)">«{{ suggestion.evidence }}»</span>
            </span>
            <span class="flex min-w-0 flex-wrap gap-1">
              <UButton
                v-for="value in choices(suggestion)"
                :key="value"
                size="xs"
                variant="soft"
                :disabled="!editable"
                :label="optionTitle(String(key), value)"
                :title="t('agentMessage.chooseCandidate')"
                class="max-w-full"
                @click="call('suggestions/accept', { kind: 'field', key, value }, t('agentMessage.fieldFilled'))"
              />
            </span>
            <span v-if="editable" class="ml-auto flex gap-1">
              <UButton size="xs" color="neutral" variant="ghost" @click="call('suggestions/reject', { kind: 'field', key })">{{ t('action.reject') }}</UButton>
            </span>
          </template>
          <template v-else>
            <span class="min-w-0">
              {{ fieldLabel(String(key)) }}: <b>{{ formatFieldValue(suggestion.value, fieldOptions(String(key))) }}</b>
              <span class="text-(--ui-text-muted)"> · {{ Math.round(suggestion.confidence * 100) }}%, {{ suggestionReason(suggestion.reason) }}</span>
              <span v-if="suggestion.evidence" class="block italic text-(--ui-text-muted)">«{{ suggestion.evidence }}»</span>
            </span>
            <span v-if="editable" class="ml-auto flex gap-1">
              <UButton size="xs" variant="soft" @click="call('suggestions/accept', { kind: 'field', key }, t('agentMessage.fieldFilled'))">{{ t('agentMessage.accept') }}</UButton>
              <UButton size="xs" color="neutral" variant="ghost" @click="call('suggestions/reject', { kind: 'field', key })">{{ t('action.reject') }}</UButton>
            </span>
          </template>
        </div>
      </div>

      <AgentActionCard
        v-for="action in actions"
        :key="action.id"
        :action="action"
        :ticket-id="ticket.id"
        :locked="links?.some((l) => l.integrationId === action.integrationId && l.status === 'found' && !l.confirmed) ?? false"
        @changed="emit('changed')"
      />

      <div
        v-for="question in questions"
        :key="question.id"
        class="border-l-2 py-0.5 pl-2.5"
        :class="openQuestionIds.has(question.id) ? 'border-(--ui-warning)' : 'border-(--ui-border)'"
      >
        <p class="flex items-start gap-1">
          <UIcon name="i-lucide-message-circle-question" class="mt-0.5 size-3.5 shrink-0 text-(--ui-warning)" />
          <span>{{ question.text }}</span>
        </p>
        <div v-if="openQuestionIds.has(question.id) && editable" class="mt-0.5 flex gap-2 pl-4.5">
          <UButton size="xs" variant="link" :padded="false" @click="emit('answer', question)">{{ t('agentMessage.answer') }}</UButton>
          <UButton size="xs" variant="link" color="neutral" :padded="false" @click="call(`questions/${question.id}/dismiss`)">{{ t('agentMessage.skip') }}</UButton>
        </div>
        <p v-else-if="!openQuestionIds.has(question.id)" class="pl-4.5 text-xs text-(--ui-text-muted)">{{ t('agentMessage.questionClosed') }}</p>
      </div>

      <button v-if="latest && data.replyUpdated && agent?.draft" type="button" class="ai-chip" @click="emit('openDraft')">
        <UIcon name="i-lucide-sparkles" class="size-3.5" />
        {{ t('agentMessage.draftReady') }}
      </button>
    </div>
  </div>
</template>
