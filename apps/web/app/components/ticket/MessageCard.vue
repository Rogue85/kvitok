<script setup lang="ts">
import type { MessageDto } from '@kvitok/shared';

const props = defineProps<{ message: MessageDto; workspaceId: string }>();
const emit = defineEmits<{ cancel: [messageId: string] }>();

const isCustomer = computed(() => props.message.authorType === 'customer');
const isNote = computed(() => props.message.visibility === 'internal');
const showFull = ref(false);
const showImages = ref(false);
const now = ref(new Date());
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  timer = setInterval(() => (now.value = new Date()), 1000);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

const author = computed(() => {
  if (isCustomer.value) return props.message.fromName || props.message.fromEmail || t('message.customer');
  return props.message.author?.name ?? props.message.fromName ?? t('ticket.operator');
});

const shortText = computed(() => props.message.bodyClean || props.message.bodyText);
const hasMore = computed(() => isCustomer.value && (Boolean(props.message.bodyHtml) || shortText.value !== props.message.bodyText));

const cancellable = computed(() =>
  props.message.deliveries.length > 0 &&
  props.message.deliveries.every((d) => d.status === 'queued' || d.status === 'cancelled') &&
  props.message.deliveries.some((d) => d.status === 'queued' && new Date(d.scheduledAt).getTime() > now.value.getTime()),
);
const secondsLeft = computed(() => {
  const queued = props.message.deliveries.find((d) => d.status === 'queued');
  return queued ? Math.max(0, Math.ceil((new Date(queued.scheduledAt).getTime() - now.value.getTime()) / 1000)) : 0;
});
const isCancelled = computed(() => props.message.deliveries.length > 0 && props.message.deliveries.every((d) => d.status === 'cancelled'));

/** Email HTML is shown in an isolated iframe: no scripts, links open in a new window. */
const srcdoc = computed(() => {
  let html = props.message.bodyHtml ?? '';
  if (showImages.value) {
    html = html.replace(/data-blocked-src=/g, 'src=');
  }
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{font:14px/1.5 system-ui,sans-serif;margin:0;color:#1f2937;word-break:break-word}img{max-width:100%}blockquote{border-left:3px solid #d1d5db;margin:0;padding-left:8px;color:#6b7280}</style></head><body>${html}</body></html>`;
});
const hasBlockedImages = computed(() => (props.message.bodyHtml ?? '').includes('data-blocked-src'));
const iframe = ref<HTMLIFrameElement | null>(null);
function fitIframe(): void {
  const doc = iframe.value?.contentDocument;
  if (iframe.value && doc) iframe.value.style.height = `${doc.documentElement.scrollHeight + 8}px`;
}
</script>

<template>
  <div
    class="rounded-lg border p-3"
    :class="[
      isNote
        ? 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40'
        : isCustomer
          ? 'border-blue-200 border-l-4 border-l-blue-500 bg-blue-50 dark:border-blue-900 dark:border-l-blue-500 dark:bg-blue-950/40'
          : 'border-(--ui-primary)/30 bg-(--ui-primary)/5',
      isCancelled ? 'opacity-60' : '',
    ]"
  >
    <div class="mb-2 flex flex-wrap items-center gap-2 text-sm">
      <UAvatar :alt="author" size="2xs" :ui="isCustomer ? { root: 'bg-blue-500', fallback: 'text-white' } : undefined" />
      <span class="font-medium">{{ author }}</span>
      <UBadge v-if="isCustomer" color="info" variant="soft" size="sm" class="rounded-full">{{ t('message.customerVia', { source: message.source === 'email' ? 'email' : 'API' }) }}</UBadge>
      <span v-if="isCustomer && message.fromEmail && message.fromName" class="text-(--ui-text-muted)">{{ message.fromEmail }}</span>
      <UBadge v-if="isNote" color="warning" variant="subtle" size="sm">{{ t('message.internal') }}</UBadge>
      <UBadge v-if="message.isAutomated" color="neutral" variant="subtle" size="sm">{{ t('message.autoReply') }}</UBadge>
      <UBadge v-if="!isCustomer && !isNote && message.to.length" color="neutral" variant="outline" size="sm">→ {{ message.to.join(', ') }}</UBadge>
      <span class="ml-auto text-xs text-(--ui-text-muted)" :title="formatDateTime(message.createdAt)">{{ formatRelative(message.createdAt) }}</span>
    </div>

    <iframe
      v-if="showFull && message.bodyHtml"
      ref="iframe"
      :srcdoc="srcdoc"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      class="w-full border-0"
      @load="fitIframe"
    />
    <div v-else-if="!isCustomer && message.bodyHtml" class="message-html text-sm" v-html="message.bodyHtml" />
    <p v-else class="whitespace-pre-wrap text-sm">{{ showFull ? message.bodyText : shortText }}</p>

    <div v-if="hasMore || (showFull && hasBlockedImages)" class="mt-1 flex gap-2">
      <UButton v-if="hasMore" variant="link" size="xs" :padded="false" @click="showFull = !showFull">
        {{ showFull ? t('message.hideQuote') : t('message.showFull') }}
      </UButton>
      <UButton v-if="showFull && hasBlockedImages && !showImages" variant="link" size="xs" color="neutral" @click="showImages = true">
        {{ t('message.showImages') }}
      </UButton>
    </div>

    <div v-if="message.attachments.length" class="mt-2 flex flex-wrap gap-2">
      <UButton
        v-for="attachment in message.attachments"
        :key="attachment.id"
        :href="`/api/workspaces/${workspaceId}/attachments/${attachment.id}`"
        target="_blank"
        icon="i-lucide-paperclip"
        color="neutral"
        variant="outline"
        size="xs"
      >
        {{ attachment.filename }} · {{ formatBytes(attachment.size) }}
      </UButton>
    </div>

    <div v-if="message.deliveries.length" class="mt-2 flex flex-wrap items-center gap-2">
      <UTooltip v-for="delivery in message.deliveries" :key="delivery.id" :text="delivery.lastError ?? ''" :disabled="!delivery.lastError">
        <UBadge :color="DELIVERY_COLORS[delivery.status]" variant="subtle" size="sm">
          {{ t(delivery.kind === 'email' ? 'message.deliveryEmail' : 'message.deliverySource', { status: deliveryLabel(delivery.status) }) }}
        </UBadge>
      </UTooltip>
      <UButton
        v-for="delivery in message.deliveries.filter((d) => d.sandboxEmail)"
        :key="`sandbox-${delivery.id}`"
        size="xs"
        color="warning"
        variant="ghost"
        icon="i-lucide-flask-conical"
        :to="`/w/${workspaceId}/settings/channels/${delivery.sandboxEmail!.channelId}/outbox?email=${delivery.sandboxEmail!.id}`"
      >
        {{ t('message.inSandbox') }}
      </UButton>
      <UButton v-if="cancellable" size="xs" color="neutral" variant="soft" icon="i-lucide-undo-2" @click="emit('cancel', message.id)">
        {{ t('message.cancelSending', { seconds: secondsLeft }) }}
      </UButton>
    </div>
  </div>
</template>
