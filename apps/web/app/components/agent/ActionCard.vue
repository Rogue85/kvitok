<script setup lang="ts">
import type { ActionProposalDto, ActionStatus } from '@kvitok/shared';

/**
 * An action proposed by the agent or by an operator by hand: what will be done, why, the decision and the execution result.
 * Executing an operator's action rejects every other pending proposal of the ticket, so it asks first.
 */
/** locked — the customer was found by data from the messages and is not confirmed yet: approval waits for the confirmation. */
const props = defineProps<{ action: ActionProposalDto; ticketId: string; locked?: boolean }>();
const emit = defineEmits<{ changed: [] }>();

const toast = useToast();
const { workspaceId, can } = useWorkspace();
const form = useActionForm();
const editable = computed(() => can('operator'));
const manual = computed(() => props.action.source === 'operator');
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
const status = computed(() => ({
  ...STATUS[props.action.status],
  label: manual.value && props.action.status === 'proposed' ? t('action.status.awaitingExecution') : t(`action.status.${props.action.status}`),
}));
const inactive = computed(() => props.action.status === 'superseded' || props.action.status === 'rejected');
const params = computed(() => props.action.normalizedParams ?? props.action.params);
/** The operator's action that replaced this one. */
const replacement = computed(() => (props.action.replacedById ? form?.actions.value.find((a) => a.id === props.action.replacedById) : undefined));

const rejecting = ref(false);
const comment = ref('');
const busy = ref(false);

async function decide(kind: 'approve' | 'reject' | 'retry'): Promise<void> {
  busy.value = true;
  try {
    const body =
      kind === 'retry'
        ? {}
        : { comment: comment.value.trim() || undefined, ...(kind === 'approve' && manual.value ? { pending: promisedRejections.value } : {}) };
    await api(`${url.value}/${kind}`, { method: 'POST', body });
    toast.add({ icon: 'i-lucide-check', title: kind === 'reject' ? t(manual.value ? 'action.cancelled' : 'action.rejected') : t('action.sentForExecution') });
    rejecting.value = false;
    confirming.value = false;
    comment.value = '';
    emit('changed');
  } catch (error) {
    toast.add({ color: 'error', title: error instanceof ApiError ? error.message : t('common.actionFailed') });
    // A colleague decided something meanwhile: show the ticket as it is now.
    if (error instanceof ApiError && error.status === 409) {
      confirming.value = false;
      emit('changed');
    }
  } finally {
    busy.value = false;
  }
}

/* Executing an operator's action: what else is pending is rejected, what was executed already is a warning. */
const confirming = ref(false);
const otherPending = computed(() => form?.actions.value.filter((a) => a.id !== props.action.id && a.status === 'proposed') ?? []);
const sameExecuted = computed(() => form?.actions.value.filter((a) => a.id !== props.action.id && a.action === props.action.action && a.status === 'executed') ?? []);
/** What the confirmation promised to reject, fixed when it opened: the server stops if a colleague approved one of them. */
const promisedRejections = ref<string[]>([]);
function execute(): void {
  promisedRejections.value = otherPending.value.map((a) => a.id);
  if (otherPending.value.length > 0 || sameExecuted.value.length > 0) confirming.value = true;
  else void decide('approve');
}

/** "Edit" only for an action operators may start by hand: an agent-only one can be approved or rejected, not redone. */
const editableByHand = computed(() => form?.canStart(props.action.integrationId, props.action.action) ?? false);
/** "Edit": the form with this card's parameters; a manual card is replaced by the new one, an agent's stays until execution. */
function edit(): void {
  form?.open({
    integrationId: props.action.integrationId,
    action: props.action.action,
    params: params.value,
    ...(manual.value ? { reason: props.action.reason, refreshDraft: props.action.refreshDraft, replaces: props.action.id } : {}),
  });
}
</script>

<template>
  <div
    class="space-y-1.5 rounded-md border bg-(--ui-bg)/80 px-2.5 py-2 text-xs"
    :class="action.status === 'proposed' ? 'border-(--ui-warning)/50' : action.status === 'executed' && manual ? 'border-(--ui-success)/40' : 'border-(--ui-border)'"
  >
    <div class="flex items-center gap-2">
      <UIcon :name="manual ? 'i-lucide-hand' : 'i-lucide-zap'" class="size-3.5 shrink-0" :class="manual ? 'text-(--ui-text-muted)' : 'text-(--ui-warning)'" />
      <span class="min-w-0 flex-1 truncate font-medium" :class="{ 'text-(--ui-text-muted) line-through': action.status === 'superseded' }">{{ action.title }}</span>
      <UBadge :color="status.color" :icon="status.icon" variant="subtle" size="sm">{{ status.label }}</UBadge>
    </div>

    <template v-if="action.status !== 'superseded'">
      <p v-if="action.preview" class="text-sm" :class="{ 'text-(--ui-text-muted)': inactive }">{{ action.preview }}</p>
      <p v-if="manual" class="text-(--ui-text-muted)">
        {{ t('action.proposedBy', { name: action.createdBy?.name ?? t('action.operator') }) }}: {{ t('action.quoted', { text: action.reason }) }}
      </p>
      <p v-else class="text-(--ui-text-muted)">
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
    <p v-else-if="manual" class="text-(--ui-text-muted)">{{ t('action.edited') }}</p>

    <p v-if="action.status === 'executed'" class="text-(--ui-success)">
      {{ t('action.executedAt', { time: action.executedAt ? formatRelative(action.executedAt) : '' }) }}<template v-if="action.externalRef"> · <code>{{ action.externalRef }}</code></template>
      <template v-if="action.decidedBy"> · {{ t(manual ? 'action.executedBy' : 'action.approvedBy', { name: action.decidedBy.name }) }}</template>
    </p>
    <p v-else-if="action.status === 'failed'" class="text-(--ui-error)">{{ action.error }}</p>
    <p v-else-if="action.status === 'rejected' && action.replacedById" class="flex items-center gap-1 text-(--ui-text-muted)">
      <UIcon name="i-lucide-hand" class="size-3 shrink-0" />{{ t('action.replacedBy', { action: replacement?.preview ?? replacement?.title ?? t('action.operatorAction') }) }}
    </p>
    <p v-else-if="action.status === 'rejected'" class="text-(--ui-text-muted)">
      {{ t(manual ? 'action.cancelledBy' : 'action.rejectedBy', { name: action.decidedBy?.name ?? t('action.operator') }) }}<template v-if="action.decisionComment">: {{ t('action.quoted', { text: action.decisionComment }) }}</template>
    </p>
    <p v-else-if="action.status === 'approved' || action.status === 'executing'" class="text-(--ui-text-muted)">
      {{ t('action.approvedByCapital', { name: action.decidedBy?.name ?? t('action.operator') }) }}<template v-if="action.attempts > 1"> · {{ t('action.attempt', { attempt: action.attempts }) }}</template>
    </p>
    <p v-if="manual && action.refreshDraft && ['proposed', 'approved', 'executing'].includes(action.status)" class="flex items-center gap-1 text-(--ui-text-muted)">
      <UIcon name="i-lucide-sparkles" class="size-3 shrink-0" />{{ t('action.willRefreshDraft') }}
    </p>

    <div v-if="editable && action.status === 'proposed'" class="space-y-1.5 pt-0.5">
      <UInput v-if="rejecting" v-model="comment" size="xs" :placeholder="t('action.rejectReasonPlaceholder')" class="w-full" autofocus @keydown.enter.prevent="decide('reject')" />
      <div class="flex flex-wrap gap-1">
        <template v-if="manual">
          <UTooltip :text="locked ? t('action.confirmCustomerFirst') : undefined" :disabled="!locked">
            <UButton size="xs" icon="i-lucide-play" :loading="busy" :disabled="locked" @click="execute">{{ t('action.execute') }}</UButton>
          </UTooltip>
          <UButton v-if="editableByHand" size="xs" color="neutral" variant="ghost" icon="i-lucide-pencil" @click="edit">{{ t('action.edit') }}</UButton>
          <UButton size="xs" color="neutral" variant="ghost" :loading="busy" @click="decide('reject')">{{ t('action.cancel') }}</UButton>
        </template>
        <template v-else-if="!rejecting">
          <UTooltip :text="locked ? t('action.confirmCustomerFirst') : undefined" :disabled="!locked">
            <UButton size="xs" icon="i-lucide-check" :loading="busy" :disabled="locked" @click="decide('approve')">{{ t('action.approve') }}</UButton>
          </UTooltip>
          <UButton v-if="editableByHand" size="xs" color="neutral" variant="ghost" icon="i-lucide-pencil" @click="edit">{{ t('action.edit') }}</UButton>
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

    <UModal v-model:open="confirming" :title="t('action.confirm.title', { action: action.preview ?? action.title })">
      <template #body>
        <div class="space-y-3 text-sm">
          <template v-if="otherPending.length">
            <p class="text-(--ui-text-muted)">{{ t('action.confirm.willReject') }}</p>
            <ul class="space-y-1 rounded-md border border-(--ui-border) px-3 py-2">
              <li v-for="other in otherPending" :key="other.id" class="flex items-start gap-2">
                <UIcon :name="other.source === 'operator' ? 'i-lucide-hand' : 'i-lucide-sparkles'" class="mt-0.5 size-3.5 shrink-0 text-(--ui-text-muted)" />
                <span>{{ other.preview ?? other.title }}</span>
              </li>
            </ul>
            <p class="text-xs text-(--ui-text-muted)">{{ t('action.confirm.askAgain') }}</p>
          </template>
          <UAlert
            v-if="sameExecuted.length"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :title="t('action.confirm.alreadyExecuted', { actions: sameExecuted.map((a) => a.preview ?? a.title).join('; ') })"
          />
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="confirming = false">{{ t('common.cancel') }}</UButton>
          <UButton icon="i-lucide-play" :loading="busy" @click="decide('approve')">{{ t('action.execute') }}</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
