<script setup lang="ts">
import type { MessageKey } from '@kvitok/i18n';
import type { AccordionItem } from '@nuxt/ui';
import type { PushStep, StepState } from '~/composables/usePush';

const props = defineProps<{ push: ReturnType<typeof usePush> }>();
const push = props.push;
const toast = useToast();
const deviceName = describeDevice(navigator.userAgent);

const ICONS: Record<StepState, string> = { ok: 'i-lucide-circle-check', fail: 'i-lucide-circle-x', pending: 'i-lucide-circle-dashed' };
const COLORS: Record<StepState, string> = { ok: 'text-(--ui-success)', fail: 'text-(--ui-error)', pending: 'text-(--ui-text-dimmed)' };

/** The text of a step in its state; a check that has not run yet keeps quiet. */
function describe(step: PushStep, state: StepState): string | null {
  if (step === 'browser' && state === 'fail' && push.device.inApp) return t('notifications.steps.browser.inApp');
  if (step === 'permission' && state === 'pending') return push.blockingStep.value === 'permission' ? t('notifications.steps.permission.pending') : null;
  if (step === 'subscribed' && state === 'pending') return push.blockingStep.value === 'subscribed' ? t('notifications.steps.subscribed.pending') : null;
  if (state === 'pending') return null;
  return t(`notifications.steps.${step}.${state}` as MessageKey);
}

const resetHint = computed(() => {
  const { os, browser } = push.device;
  if (os === 'ios') return t('notifications.steps.permission.reset.ios');
  if (browser === 'safari') return t('notifications.steps.permission.reset.safari');
  if (browser === 'firefox') return t('notifications.steps.permission.reset.firefox');
  if (browser === 'chrome' || browser === 'edge' || browser === 'yandex' || browser === 'samsung') return t('notifications.steps.permission.reset.chrome');
  return t('notifications.steps.permission.reset.generic');
});

const systemHint = computed(() => t(`notifications.system.${push.device.os === 'other' ? 'generic' : push.device.os}` as MessageKey));
const showSystemHint = ref(false);

async function enable(): Promise<void> {
  try {
    await push.enable();
  } catch (e) {
    toast.add({ color: 'error', title: e instanceof ApiError ? e.message : t('notifications.enableFailed'), description: e instanceof ApiError ? undefined : String(e) });
  }
}

async function disable(): Promise<void> {
  try {
    await push.disable();
    toast.add({ title: t('notifications.disabled'), icon: 'i-lucide-bell-off' });
  } catch (e) {
    toast.add({ color: 'error', title: e instanceof ApiError ? e.message : t('common.actionFailed') });
  }
}

async function sendTest(): Promise<void> {
  const current = push.current.value;
  if (!current) return;
  try {
    const error = await push.test(current.id);
    if (error) toast.add({ color: 'error', title: t('notifications.testFailed', { error }) });
    else toast.add({ title: t('notifications.testSent'), icon: 'i-lucide-send' });
    showSystemHint.value = true;
  } catch (e) {
    toast.add({ color: 'error', title: e instanceof ApiError ? e.message : t('common.actionFailed') });
  }
}

const guide: AccordionItem[] = [
  { label: t('notifications.guide.iosTitle'), icon: 'i-lucide-smartphone', content: t('notifications.guide.ios') },
  { label: t('notifications.guide.androidTitle'), icon: 'i-lucide-tablet-smartphone', content: t('notifications.guide.android') },
  { label: t('notifications.guide.desktopTitle'), icon: 'i-lucide-monitor', content: t('notifications.guide.desktop') },
];
</script>

<template>
  <UCard>
    <div class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-bell" class="size-5" />
          <h2 class="font-semibold">{{ t('notifications.thisDevice') }}</h2>
          <span v-if="deviceName" class="text-sm text-(--ui-text-muted)">{{ deviceName }}</span>
        </div>
        <div class="flex flex-wrap gap-2">
          <template v-if="push.current.value">
            <UButton icon="i-lucide-send" color="neutral" variant="soft" :label="t('notifications.sendTest')" @click="sendTest" />
            <UButton icon="i-lucide-bell-off" color="neutral" variant="ghost" :label="t('notifications.disable')" :loading="push.busy.value" @click="disable" />
          </template>
          <UButton v-else-if="push.canEnable.value" icon="i-lucide-bell-ring" :label="t('notifications.enable')" :loading="push.busy.value" @click="enable" />
        </div>
      </div>

      <ul class="space-y-3">
        <li v-for="item in push.steps.value" :key="item.step" class="flex gap-3">
          <UIcon :name="ICONS[item.state]" class="mt-0.5 size-5 shrink-0" :class="COLORS[item.state]" />
          <div class="min-w-0 space-y-1">
            <p class="text-sm font-medium" :class="item.state === 'pending' && push.blockingStep.value !== item.step ? 'text-(--ui-text-dimmed)' : ''">
              {{ t(`notifications.steps.${item.step}.title` as MessageKey) }}
            </p>
            <p v-if="describe(item.step, item.state)" class="text-sm text-(--ui-text-muted)">{{ describe(item.step, item.state) }}</p>
            <ol v-if="item.step === 'homeScreen' && item.state === 'fail'" class="list-decimal space-y-0.5 pl-5 text-sm">
              <li>{{ t('notifications.steps.homeScreen.step1') }}</li>
              <li>{{ t('notifications.steps.homeScreen.step2') }}</li>
              <li>{{ t('notifications.steps.homeScreen.step3') }}</li>
              <li>{{ t('notifications.steps.homeScreen.step4') }}</li>
            </ol>
            <p v-if="item.step === 'permission' && item.state === 'fail'" class="text-sm">{{ resetHint }}</p>
          </div>
        </li>
      </ul>

      <UAlert v-if="showSystemHint" color="neutral" variant="subtle" icon="i-lucide-info" :title="t('notifications.system.title')" :description="systemHint" />

      <div>
        <p class="text-sm font-medium">{{ t('notifications.otherDevices') }}</p>
        <UAccordion :items="guide" :ui="{ trigger: 'text-sm', body: 'text-sm text-(--ui-text-muted)' }" />
      </div>
    </div>
  </UCard>
</template>
