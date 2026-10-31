<script setup lang="ts">
import type { AgentRunDetailDto, AgentRunDto } from '@kvitok/shared';

/** `currency` — the workspace one, run costs are in it. */
const props = defineProps<{ runs: AgentRunDto[]; runId?: string | null; currency: string }>();
const open = defineModel<boolean>('open', { default: false });
const { workspaceId } = useWorkspace();

const STATUS_COLORS: Record<string, 'neutral' | 'success' | 'warning' | 'error' | 'info'> = {
  queued: 'neutral',
  running: 'info',
  applied: 'success',
  stale: 'warning',
  failed: 'error',
  cancelled: 'neutral',
};
const MODES = ['triage', 'refine'] as const;
const STATUSES = ['queued', 'running', 'applied', 'stale', 'failed', 'cancelled'] as const;
const TRIGGERS = ['ticket_created', 'customer_message', 'operator_message', 'question_answer', 'manual', 'stale_rerun', 'customer_linked'] as const;

function modeLabel(mode: string): string {
  const known = MODES.find((m) => m === mode);
  return known ? t(`agentRuns.mode.${known}`) : mode;
}
function runStatusLabel(status: string): string {
  const known = STATUSES.find((s) => s === status);
  return known ? t(`agentRuns.status.${known}`) : status;
}
function triggerLabel(trigger: string): string {
  const known = TRIGGERS.find((tr) => tr === trigger);
  return known ? t(`agentRuns.trigger.${known}`) : trigger;
}

const selectedId = ref<string | null>(null);
watch(open, (value) => {
  if (value) selectedId.value = props.runId ?? props.runs[0]?.id ?? null;
});
const { data: detail, status } = await useAsyncData(
  () => `agent-run:${selectedId.value}`,
  () => (selectedId.value ? api<AgentRunDetailDto>(`/workspaces/${workspaceId.value}/agent/runs/${selectedId.value}`) : Promise.resolve(null)),
  { watch: [selectedId] },
);

function pretty(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
</script>

<template>
  <UModal v-model:open="open" :title="t('ticket.agentRuns')" :ui="{ content: 'max-w-5xl' }">
    <template #body>
      <div class="flex h-[70vh] gap-4">
        <ul class="w-64 shrink-0 space-y-1 overflow-y-auto">
          <li v-for="run in runs" :key="run.id">
            <button
              class="w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-(--ui-bg-muted)"
              :class="selectedId === run.id ? 'bg-(--ui-bg-muted)' : ''"
              @click="selectedId = run.id"
            >
              <div class="flex items-center gap-1">
                <span class="font-medium">{{ modeLabel(run.mode) }}</span>
                <UBadge :color="STATUS_COLORS[run.status]" variant="subtle" size="sm">{{ runStatusLabel(run.status) }}</UBadge>
                <UBadge v-if="run.dryRun" color="neutral" variant="outline" size="sm">{{ t('agentRuns.dryRun') }}</UBadge>
              </div>
              <div class="text-(--ui-text-muted)">
                {{ triggerLabel(run.trigger.type) }} · {{ formatRelative(run.createdAt) }}<template v-if="run.cost !== null"> · {{ formatMoney(run.cost, currency) }}</template>
              </div>
            </button>
          </li>
        </ul>
        <div class="min-w-0 flex-1 space-y-3 overflow-y-auto text-xs">
          <template v-if="detail">
            <div class="flex flex-wrap gap-x-4 gap-y-1 text-(--ui-text-muted)">
              <span>{{ t('agentRuns.model', { model: detail.model ?? '—' }) }}</span>
              <span>{{ t('agentRuns.configVersion', { version: detail.configVersion ?? '—' }) }}</span>
              <span>{{ t('agentRuns.tokens', { input: detail.tokensIn, output: detail.tokensOut }) }}</span>
              <span v-if="detail.cost !== null">{{ t('agentRuns.cost', { cost: formatMoney(detail.cost, currency) }) }}</span>
            </div>
            <UAlert v-if="detail.error" color="error" variant="subtle" :title="detail.error" />
            <div v-for="step in detail.steps" :key="step.index" class="rounded-md border border-(--ui-border) p-2">
              <div class="mb-1 flex items-center gap-2">
                <UBadge :color="step.kind === 'llm' ? 'primary' : 'neutral'" variant="subtle" size="sm">{{ step.kind === 'llm' ? 'LLM' : t('agentRuns.tool') }}</UBadge>
                <span class="font-mono">{{ step.name }}</span>
                <span class="ml-auto text-(--ui-text-muted)">{{ t('agentRuns.duration', { ms: step.durationMs }) }}<template v-if="step.tokensIn !== null"> · {{ t('agentRuns.stepTokens', { input: step.tokensIn, output: step.tokensOut ?? 0 }) }}</template></span>
              </div>
              <p v-if="step.error" class="mb-1 text-(--ui-error)">{{ step.error }}</p>
              <details>
                <summary class="cursor-pointer text-(--ui-text-muted)">{{ t('agentRuns.inputOutput') }}</summary>
                <pre class="mt-1 max-h-64 overflow-auto rounded bg-(--ui-bg-muted) p-2">{{ pretty(step.input) }}</pre>
                <pre class="mt-1 max-h-64 overflow-auto rounded bg-(--ui-bg-muted) p-2">{{ pretty(step.output) }}</pre>
              </details>
            </div>
            <details v-if="detail.inputSnapshot">
              <summary class="cursor-pointer font-medium">{{ t('agentRuns.prompt') }}</summary>
              <pre class="mt-1 whitespace-pre-wrap rounded bg-(--ui-bg-muted) p-2">{{ pretty(detail.inputSnapshot) }}</pre>
            </details>
            <details v-if="detail.output">
              <summary class="cursor-pointer font-medium">{{ t('agentRuns.result') }}</summary>
              <pre class="mt-1 whitespace-pre-wrap rounded bg-(--ui-bg-muted) p-2">{{ pretty(detail.output) }}</pre>
            </details>
          </template>
          <p v-else-if="status === 'pending'" class="text-(--ui-text-muted)">{{ t('common.loading') }}</p>
        </div>
      </div>
    </template>
  </UModal>
</template>
