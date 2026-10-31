<script setup lang="ts">
import type { ActionProposalDto, ActionStatus } from '@kvitok/shared';

/** An action proposed by the agent: what will be done, why, the operator's decision and the execution result. */
const props = defineProps<{ action: ActionProposalDto; ticketId: string }>();
const emit = defineEmits<{ changed: [] }>();

const toast = useToast();
const { workspaceId, can } = useWorkspace();
const editable = computed(() => can('operator'));
const url = computed(() => `/workspaces/${workspaceId.value}/tickets/${props.ticketId}/actions/${props.action.id}`);

const STATUS: Record<ActionStatus, { color: 'warning' | 'info' | 'success' | 'error' | 'neutral'; icon: string }> = {
  proposed: { color: 'warning', icon: 'i-lucide-hand' },
  approved: { color: 'info', icon: 'i-lucide-loader' },
  executing: { color: 'info', icon: 'i-lucide-loader' },
  executed: { color: 'success', icon: 'i-lucide-check' },
  failed: { color: 'error', icon: 'i-lucide-circle-x' },
  rejected: { color: 'neutral', icon: 'i-lucide-x' },
  superseded: { color: 'neutral', icon: 'i-lucide-replace' },
};
const status = computed(() => ({ ...STATUS[props.action.status], label: t(`action.status.${props.action.status}`) }));
const inactive = computed(() => props.action.status === 'superseded' || props.action.status === 'rejected');
const params = computed(() => props.action.normalizedParams ?? props.action.params);

const rejecting = ref(false);
const comment = ref('');
const busy = ref(false);

async function decide(kind: 'approve' | 'reject' | 'retry'): Promise<void> {
  busy.value = true;
  try {
    await api(`${url.value}/${kind}`, { method: 'POST', body: kind === 'retry' ? {} : { comment: comment.value.trim() || undefined } });
    toast.add({ icon: 'i-lucide-check', title: kind === 'reject' ? t('action.rejected') : t('action.sentForExecution') });
    rejecting.value = false;
    comment.value = '';
    emit('changed');
  } catch (error) {
    toast.add({ color: 'error', title: error instanceof ApiError ? error.message : t('common.actionFailed') });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="space-y-1.5 rounded-md border bg-(--ui-bg)/80 px-2.5 py-2 text-xs" :class="action.status === 'proposed' ? 'border-(--ui-warning)/50' : 'border-(--ui-border)'">
    <div class="flex items-center gap-2">
      <UIcon name="i-lucide-zap" class="size-3.5 shrink-0 text-(--ui-warning)" />
      <span class="min-w-0 flex-1 truncate font-medium" :class="{ 'text-(--ui-text-muted) line-through': action.status === 'superseded' }">{{ action.title }}</span>
      <UBadge :color="status.color" :icon="status.icon" variant="subtle" size="sm">{{ status.label }}</UBadge>
    </div>

    <template v-if="action.status !== 'superseded'">
      <p v-if="action.preview" class="text-sm" :class="{ 'text-(--ui-text-muted)': inactive }">{{ action.preview }}</p>
      <p class="text-(--ui-text-muted)">
        {{ action.reason }}<template v-if="action.calculation"> · {{ action.calculation }}</template>
      </p>
      <ul v-if="action.warnings.length" class="space-y-0.5 text-(--ui-warning)">
        <li v-for="warning in action.warnings" :key="warning" class="flex items-start gap-1">
          <UIcon name="i-lucide-triangle-alert" class="mt-0.5 size-3 shrink-0" />{{ warning }}
        </li>
      </ul>
      <details class="text-(--ui-text-muted)">
        <summary class="cursor-pointer select-none">{{ t('action.parameters', { integration: action.integrationName }) }}</summary>
        <pre class="mt-1 overflow-x-auto rounded bg-(--ui-bg-elevated) p-1.5 font-mono text-[11px]">{{ JSON.stringify(params, null, 2) }}</pre>
      </details>
    </template>

    <p v-if="action.status === 'executed'" class="text-(--ui-success)">
      {{ t('action.executedAt', { time: action.executedAt ? formatRelative(action.executedAt) : '' }) }}<template v-if="action.externalRef"> · <code>{{ action.externalRef }}</code></template>
      <template v-if="action.decidedBy"> · {{ t('action.approvedBy', { name: action.decidedBy.name }) }}</template>
    </p>
    <p v-else-if="action.status === 'failed'" class="text-(--ui-error)">{{ action.error }}</p>
    <p v-else-if="action.status === 'rejected'" class="text-(--ui-text-muted)">
      {{ t('action.rejectedBy', { name: action.decidedBy?.name ?? t('action.operator') }) }}<template v-if="action.decisionComment">: {{ t('action.quoted', { text: action.decisionComment }) }}</template>
    </p>
    <p v-else-if="action.status === 'approved' || action.status === 'executing'" class="text-(--ui-text-muted)">
      {{ t('action.approvedByCapital', { name: action.decidedBy?.name ?? t('action.operator') }) }}<template v-if="action.attempts > 1"> · {{ t('action.attempt', { attempt: action.attempts }) }}</template>
    </p>

    <div v-if="editable && action.status === 'proposed'" class="space-y-1.5 pt-0.5">
      <UInput v-if="rejecting" v-model="comment" size="xs" :placeholder="t('action.rejectReasonPlaceholder')" class="w-full" autofocus @keydown.enter.prevent="decide('reject')" />
      <div class="flex gap-1">
        <template v-if="!rejecting">
          <UButton size="xs" icon="i-lucide-check" :loading="busy" @click="decide('approve')">{{ t('action.approve') }}</UButton>
          <UButton size="xs" color="neutral" variant="ghost" @click="rejecting = true">{{ t('action.reject') }}</UButton>
        </template>
        <template v-else>
          <UButton size="xs" color="error" variant="soft" :loading="busy" @click="decide('reject')">{{ t('action.reject') }}</UButton>
          <UButton size="xs" color="neutral" variant="ghost" @click="rejecting = false">{{ t('common.cancel') }}</UButton>
        </template>
      </div>
    </div>
    <UButton v-if="editable && action.status === 'failed'" size="xs" variant="soft" icon="i-lucide-rotate-ccw" :loading="busy" @click="decide('retry')">
      {{ t('action.retry') }}
    </UButton>
  </div>
</template>
