<script setup lang="ts">
import type { MessageDto, TicketAgentDto, TicketDto } from '@kvitok/shared';

/** The input at the bottom of the ticket: everything typed here is a message to the agent (visible to the team only). */
const props = defineProps<{
  ticket: TicketDto;
  agent: TicketAgentDto | null;
  replyOpen: boolean;
  /** Called before sending: save the draft edits so the agent sees the current text. */
  beforeSend?: () => Promise<void>;
}>();
const emit = defineEmits<{ sent: [message: MessageDto]; reply: [] }>();
/** The agent's question being answered. */
const replyTo = defineModel<{ id: string; text: string } | null>('replyTo', { default: null });

const toast = useToast();
const { workspaceId } = useWorkspace();
const base = computed(() => `/workspaces/${workspaceId.value}/tickets/${props.ticket.id}`);
const text = ref('');
const sending = ref(false);
const prompt = ref<{ textareaRef: HTMLTextAreaElement | null } | null>(null);

const enabled = computed(() => props.agent?.enabled ?? false);
const placeholder = computed(() => {
  if (!enabled.value) return t('agentChat.placeholder.disabled');
  if (replyTo.value) return t('agentChat.placeholder.answer');
  return props.replyOpen ? t('agentChat.placeholder.refineReply') : t('agentChat.placeholder.default');
});

watch(replyTo, async (question) => {
  if (question) {
    await nextTick();
    prompt.value?.textareaRef?.focus();
  }
});

async function submit(): Promise<void> {
  const body = text.value.trim();
  if (!body || sending.value) return;
  sending.value = true;
  try {
    await props.beforeSend?.();
    const message = replyTo.value
      ? await api<MessageDto>(`${base.value}/agent/questions/${replyTo.value.id}/answer`, { method: 'POST', body: { body } })
      : await api<MessageDto>(`${base.value}/agent/messages`, { method: 'POST', body: { body } });
    text.value = '';
    replyTo.value = null;
    emit('sent', message);
  } catch (error) {
    toast.add({ color: 'error', title: error instanceof ApiError ? error.message : t('reply.sendFailed') });
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <UChatPrompt ref="prompt" v-model="text" :placeholder="placeholder" :rows="1" autoresize :maxrows="8" variant="subtle" @submit="submit">
    <template v-if="replyTo" #header>
      <div class="flex items-center gap-2 text-xs">
        <UIcon name="i-lucide-corner-down-right" class="size-3.5 shrink-0 text-(--ui-warning)" />
        <span class="truncate text-(--ui-text-muted)">{{ t('agentChat.answeringQuestion', { question: replyTo.text }) }}</span>
        <UButton class="ml-auto" icon="i-lucide-x" size="xs" color="neutral" variant="ghost" :aria-label="t('agentChat.dontAnswer')" @click="replyTo = null" />
      </div>
    </template>
    <template #footer>
      <div class="flex items-center gap-1.5 text-xs text-(--ui-text-muted)">
        <UIcon name="i-lucide-lock" class="size-3.5" />
        {{ t('agentChat.teamOnly') }}
      </div>
      <div class="flex items-center gap-2">
        <UButton v-if="!replyOpen" size="sm" color="neutral" variant="outline" icon="i-lucide-reply" @click="emit('reply')">{{ t('agentChat.replyToCustomer') }}</UButton>
        <UChatPromptSubmit :status="sending ? 'submitted' : 'ready'" :disabled="!text.trim()" />
      </div>
    </template>
  </UChatPrompt>
</template>
