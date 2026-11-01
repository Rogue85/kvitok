<script setup lang="ts">
import type { CustomerLinkDto, MessageDto, ReplyDraftDto, TicketAgentDto, TicketDto } from '@kvitok/shared';
import type { DropdownMenuItem, EditorToolbarItem } from '@nuxt/ui';

const props = defineProps<{ ticket: TicketDto; lastSeenMessageId: string | null; agent: TicketAgentDto | null; links?: CustomerLinkDto[] }>();
const emit = defineEmits<{ sent: [message: MessageDto]; changed: []; close: [] }>();

const toast = useToast();
const mobile = useMobile();
/** Text of sent replies without the signature — to put it back into the editor on cancel. */
const sentDrafts = new Map<string, { html: string; toastId: string | number }>();
const { workspaceId } = useWorkspace();
const base = computed(() => `/workspaces/${workspaceId.value}/tickets/${props.ticket.id}`);

/** A customer found by data from the messages and not confirmed: the draft may carry someone else's data. */
const unconfirmed = computed(() => props.links?.find((l) => l.status === 'found' && !l.confirmed) ?? null);
function showDecision(): void {
  const eventId = unconfirmed.value?.pending?.eventId;
  if (eventId) document.getElementById(`event-${eventId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

const html = ref('');
const sending = ref(false);
const staleWarning = ref<string | null>(null);

const canEmail = computed(() => props.ticket.replyOptions.email !== null);
const canSource = computed(() => props.ticket.replyOptions.source);
const canReply = computed(() => canEmail.value || canSource.value);
/** Why there is nowhere to reply: a reply to the source goes only to the channel the ticket came through. */
const noReplyReason = computed(() => {
  const channel = props.ticket.channel;
  if (channel?.type === 'api') return t('reply.nowhere.api', { channel: channel.name });
  if (channel?.type === 'email') return t('reply.nowhere.email', { channel: channel.name });
  return t('reply.nowhere.noChannel');
});

const to = ref<string[]>([]);
const cc = ref<string[]>([]);
const via = ref<Array<'email' | 'source'>>([]);
const statusAfter = ref<'pending' | 'resolved' | 'keep'>('pending');
const editRecipients = ref(false);

function resetRecipients(): void {
  const customers = props.ticket.participants.filter((p) => p.role === 'customer').map((p) => p.email);
  // A ticket from the API without an email: the customer may have got an address later (profile link).
  to.value = customers.length > 0 ? customers : (props.ticket.customer?.identities ?? []).filter((i) => i.type === 'email').map((i) => i.value);
  cc.value = props.ticket.participants.filter((p) => p.role === 'cc').map((p) => p.email);
  via.value = canEmail.value ? ['email'] : canSource.value ? ['source'] : [];
  editRecipients.value = via.value.includes('email') && to.value.length === 0;
}
watch(() => props.ticket.id, resetRecipients, { immediate: true });
/** Email is selected but there is no recipient — cannot send. */
const missingRecipient = computed(() => via.value.includes('email') && to.value.length === 0);

const viaItems = computed(() => [
  ...(canEmail.value ? [{ label: `Email (${props.ticket.replyOptions.email!.address})`, value: 'email' }] : []),
  ...(canSource.value ? [{ label: t('reply.viaSource', { channel: props.ticket.channel?.name ?? 'API' }), value: 'source' }] : []),
]);
/** The collapsed "where the reply goes" line. */
const recipientsLine = computed(() => {
  const parts: string[] = [];
  if (via.value.includes('email')) {
    parts.push(t('reply.emailTo', { to: to.value.join(', ') || t('reply.noRecipient') }) + (cc.value.length ? t('reply.ccCount', { count: cc.value.length }) : ''));
  }
  if (via.value.includes('source')) parts.push(t('reply.toSource', { channel: props.ticket.channel?.name ?? 'API' }));
  return parts.join(' · ') || t('reply.noChannelSelected');
});

const STATUS_AFTER = ['pending', 'resolved', 'keep'] as const;
const statusMenu = computed<DropdownMenuItem[]>(() =>
  STATUS_AFTER.map((value) => ({
    label: t(`reply.send.${value}`),
    icon: statusAfter.value === value ? 'i-lucide-check' : undefined,
    onSelect: () => (statusAfter.value = value),
  })),
);

const toolbar: EditorToolbarItem[][] = [
  [
    { kind: 'mark', mark: 'bold', icon: 'i-lucide-bold' },
    { kind: 'mark', mark: 'italic', icon: 'i-lucide-italic' },
  ],
  [
    { kind: 'bulletList', icon: 'i-lucide-list' },
    { kind: 'orderedList', icon: 'i-lucide-list-ordered' },
    { kind: 'blockquote', icon: 'i-lucide-text-quote' },
  ],
  [{ kind: 'link', icon: 'i-lucide-link' }],
];

const isEmptyHtml = computed(() => html.value.replace(/<[^>]*>/g, '').trim() === '');

/* Draft: the agent's text is filled in until the operator starts editing; edits are saved automatically. */
const synced = reactive<{ id: string | null; body: string }>({ id: null, body: '' });
watch(
  () => props.agent?.draft,
  (draft) => {
    if (!draft || (draft.id === synced.id && draft.bodyHtml === synced.body)) return;
    // A message to the agent saves the edits before sending (flush), so the new version after it also counts as "untouched".
    if (html.value === synced.body || isEmptyHtml.value) {
      html.value = draft.bodyHtml;
    }
    synced.id = draft.id;
    synced.body = draft.bodyHtml;
  },
  { immediate: true },
);
async function persistDraft(body: string): Promise<void> {
  if (body === synced.body) return;
  try {
    const draft = await api<ReplyDraftDto | null>(`${base.value}/draft`, { method: 'PUT', body: { bodyHtml: body } });
    synced.id = draft?.id ?? null;
    synced.body = draft?.bodyHtml ?? '';
  } catch {
    // the draft is not critical: sending takes the text from the editor anyway
  }
}
const saveDraft = debounce((body: string) => void persistDraft(body), 1500);
watch(html, (body) => {
  if (body !== synced.body && !sending.value) saveDraft(body);
});
/** Save edits right away — before a message to the agent, so it sees the current text. */
async function flush(): Promise<void> {
  await persistDraft(html.value);
}

const suggested = computed(() => props.agent?.suggestedDraft ?? null);
const compareOpen = ref(false);
async function takeSuggested(): Promise<void> {
  if (!suggested.value) return;
  const draft = suggested.value;
  await api(`${base.value}/drafts/${draft.id}/accept`, { method: 'POST' });
  html.value = draft.bodyHtml;
  synced.id = draft.id;
  synced.body = draft.bodyHtml;
  compareOpen.value = false;
  emit('changed');
}
async function keepMine(): Promise<void> {
  if (!suggested.value) return;
  await api(`${base.value}/drafts/${suggested.value.id}/discard`, { method: 'POST' });
  compareOpen.value = false;
  emit('changed');
}

const draftLabel = computed(() => {
  const draft = props.agent?.draft;
  if (!draft) return null;
  return draft.source === 'agent' ? t('reply.agentVersion', { version: draft.version }) : t('reply.editsSaved');
});

async function sendReply(force = false): Promise<void> {
  if (isEmptyHtml.value || via.value.length === 0 || missingRecipient.value) return;
  sending.value = true;
  staleWarning.value = null;
  try {
    const message = await api<MessageDto>(`${base.value}/replies`, {
      method: 'POST',
      body: {
        bodyHtml: html.value,
        via: via.value,
        ...(via.value.includes('email') ? { to: to.value, cc: cc.value } : {}),
        statusAfter: statusAfter.value === 'keep' ? null : statusAfter.value,
        ...(props.lastSeenMessageId ? { lastSeenMessageId: props.lastSeenMessageId } : {}),
        force,
      },
    });
    const draft = html.value;
    html.value = '';
    synced.id = null;
    synced.body = '';
    emit('sent', message);
    const notice = toast.add({
      title: t('reply.sendingSoon'),
      icon: 'i-lucide-send',
      duration: 8000,
      actions: [{ label: t('common.cancel'), color: 'neutral', variant: 'outline', onClick: () => void cancel(message.id, draft) }],
    });
    sentDrafts.set(message.id, { html: draft, toastId: notice.id });
  } catch (error) {
    if (error instanceof ApiError && error.code === 'stale_conversation') {
      staleWarning.value = error.message;
    } else {
      toast.add({ color: 'error', title: error instanceof ApiError ? error.message : t('reply.sendFailed') });
    }
  } finally {
    sending.value = false;
  }
}

async function cancel(messageId: string, draft: string): Promise<void> {
  try {
    await api(`${base.value}/messages/${messageId}/cancel`, { method: 'POST' });
    const sent = sentDrafts.get(messageId);
    if (sent) {
      toast.remove(sent.toastId);
      sentDrafts.delete(messageId);
    }
    html.value = sent?.html ?? draft;
    toast.add({ title: t('reply.cancelled'), icon: 'i-lucide-undo-2' });
  } catch (error) {
    toast.add({ color: 'error', title: error instanceof ApiError ? error.message : t('reply.cancelFailed') });
  }
}

defineExpose({ cancel, flush });
</script>

<template>
  <div class="rounded-lg border border-(--ui-primary)/40 bg-(--ui-bg)">
    <div class="flex items-center gap-2 px-3 pt-2 text-sm">
      <UIcon name="i-lucide-reply" class="size-4 shrink-0 text-(--ui-primary)" />
      <span class="shrink-0 font-medium">{{ t('reply.title') }}</span>
      <button v-if="canReply" type="button" class="min-w-0 truncate text-xs text-(--ui-text-muted) hover:text-(--ui-text)" @click="editRecipients = !editRecipients">
        {{ recipientsLine }} · <span class="underline decoration-dotted">{{ editRecipients ? t('reply.collapse') : t('reply.change') }}</span>
      </button>
      <UButton class="ml-auto" icon="i-lucide-x" size="xs" color="neutral" variant="ghost" :aria-label="t('reply.collapseReply')" @click="emit('close')" />
    </div>

    <div class="space-y-3 p-3">
      <UAlert
        v-if="unconfirmed"
        color="warning"
        variant="subtle"
        icon="i-lucide-user-search"
        :title="t('reply.unconfirmedCustomer.title', { customer: unconfirmed.displayName ?? unconfirmed.customerRef ?? '' })"
        :description="unconfirmed.pending?.kind === 'conflict' ? t('reply.unconfirmedCustomer.conflict') : t('reply.unconfirmedCustomer.description')"
        :actions="unconfirmed.pending ? [{ label: t('reply.unconfirmedCustomer.show'), color: 'warning', variant: 'outline', onClick: showDecision }] : []"
      />
      <UAlert
        v-if="!canReply"
        color="warning"
        variant="subtle"
        icon="i-lucide-mail-warning"
        :title="t('reply.nowhere.title')"
        :description="noReplyReason"
      />
      <template v-else>
        <div v-if="editRecipients" class="space-y-2 rounded-md bg-(--ui-bg-muted) p-2">
          <UCheckboxGroup v-model="via" :items="viaItems" orientation="horizontal" />
          <div v-if="via.includes('email')" class="grid gap-2 sm:grid-cols-2">
            <UFormField :label="t('reply.to')" size="sm" :error="missingRecipient ? t('reply.recipientRequired') : undefined">
              <UInputTags v-model="to" placeholder="email" class="w-full" />
            </UFormField>
            <UFormField :label="t('reply.cc')" size="sm"><UInputTags v-model="cc" placeholder="email" class="w-full" /></UFormField>
          </div>
        </div>

        <UAlert
          v-if="suggested"
          color="info"
          variant="subtle"
          icon="i-lucide-sparkles"
          :title="t('reply.suggested.title')"
          :description="t('reply.suggested.description')"
          :actions="[
            { label: t('reply.suggested.compare'), color: 'info', variant: 'outline', onClick: () => (compareOpen = true) },
            { label: t('reply.takeAgentVersion'), color: 'info', onClick: () => void takeSuggested() },
          ]"
        />
        <UEditor v-slot="{ editor }" v-model="html" content-type="html" :placeholder="t('reply.placeholder')" class="min-h-32 rounded-md border border-(--ui-border) px-3 py-2">
          <UEditorToolbar :editor="editor" :items="toolbar" class="-mx-1 mb-2 border-b border-(--ui-border) pb-1" />
        </UEditor>

        <UAlert
          v-if="staleWarning"
          color="warning"
          variant="subtle"
          icon="i-lucide-message-circle-warning"
          :title="staleWarning"
          :actions="[{ label: t('reply.sendAnyway'), color: 'warning', variant: 'outline', onClick: () => void sendReply(true) }]"
        />

        <div class="flex items-center gap-2">
          <span v-if="draftLabel" class="min-w-0 truncate text-xs text-(--ui-text-muted)">{{ draftLabel }}</span>
          <UFieldGroup class="ml-auto shrink-0">
            <UButton icon="i-lucide-send" :loading="sending" :disabled="isEmptyHtml || via.length === 0 || missingRecipient" @click="sendReply()">
              {{ t(`reply.send.${statusAfter}`) }}
            </UButton>
            <UDropdownMenu :items="statusMenu" :content="{ align: 'end' }">
              <UButton icon="i-lucide-chevron-down" :aria-label="t('reply.statusAfter')" />
            </UDropdownMenu>
          </UFieldGroup>
        </div>
      </template>
    </div>

    <UModal v-model:open="compareOpen" :title="t('reply.compareTitle')" :fullscreen="mobile" :ui="{ content: 'max-w-4xl' }">
      <template #body>
        <div class="grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <p class="mb-2 font-medium">{{ t('reply.yourVersion') }}</p>
            <div class="message-html rounded-md border border-(--ui-border) p-3" v-html="html" />
          </div>
          <div>
            <p class="mb-2 font-medium">{{ t('reply.agentVersionTitle') }}</p>
            <div class="message-html rounded-md border border-(--ui-primary)/40 p-3" v-html="suggested?.bodyHtml ?? ''" />
          </div>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" @click="keepMine">{{ t('reply.keepMine') }}</UButton>
        <UButton @click="takeSuggested">{{ t('reply.takeAgentVersion') }}</UButton>
      </template>
    </UModal>
  </div>
</template>
