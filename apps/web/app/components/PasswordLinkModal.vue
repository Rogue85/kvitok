<script setup lang="ts">
import type { PasswordLinkDto } from '@kvitok/shared';

/** Shows a one-time invitation or password reset link to pass on: there is no system mail to send it. */
const props = defineProps<{ link: PasswordLinkDto | null; name: string }>();
const emit = defineEmits<{ close: [] }>();

const copy = useCopy();
const url = computed(() => (props.link ? `${window.location.origin}/invite/${props.link.token}` : ''));
</script>

<template>
  <UModal
    :open="link !== null"
    :title="link?.purpose === 'reset' ? t('passwordLink.resetTitle') : t('passwordLink.inviteTitle')"
    :description="t('passwordLink.description', { name })"
    @update:open="(open: boolean) => !open && emit('close')"
  >
    <template #body>
      <div v-if="link" class="space-y-2">
        <div class="flex gap-2">
          <UInput :model-value="url" readonly class="flex-1 font-mono" @focus="($event.target as HTMLInputElement).select()" />
          <UButton icon="i-lucide-copy" color="neutral" variant="soft" :aria-label="t('common.copy')" @click="copy(url)" />
        </div>
        <p class="text-sm text-(--ui-text-muted)">{{ t('passwordLink.expires', { date: formatDateTime(link.expiresAt) }) }}</p>
      </div>
    </template>
    <template #footer>
      <UButton @click="emit('close')">{{ t('common.close') }}</UButton>
    </template>
  </UModal>
</template>
