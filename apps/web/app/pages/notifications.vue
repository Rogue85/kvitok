<script setup lang="ts">
import type { PushSubscriptionDto } from '@kvitok/shared';

const toast = useToast();
const { me } = useAuth();
const push = usePush();
await push.refresh().catch(() => undefined);

const workspaces = computed(() => (me.value?.workspaces ?? []).filter((w) => w.isMember));
const lastWorkspaceId = useState<string | null>('workspace:last');
const selected = ref(workspaces.value.find((w) => w.workspaceId === lastWorkspaceId.value)?.workspaceId ?? workspaces.value[0]?.workspaceId ?? null);
const workspaceTabs = computed(() => workspaces.value.map((w) => ({ label: w.workspaceName, value: w.workspaceId })));
const selectedRole = computed(() => workspaces.value.find((w) => w.workspaceId === selected.value)?.role ?? 'viewer');

async function remove(subscription: PushSubscriptionDto): Promise<void> {
  try {
    if (subscription.current) await push.disable();
    else await push.remove(subscription.id);
  } catch (e) {
    toast.add({ color: 'error', title: e instanceof ApiError ? e.message : t('common.actionFailed') });
  }
}
</script>

<template>
  <UDashboardPanel id="notifications">
    <template #header>
      <UDashboardNavbar :title="t('nav.notifications')" />
    </template>

    <template #body>
      <div class="max-w-3xl space-y-8">
        <p class="text-sm text-(--ui-text-muted)">{{ t('notifications.intro') }}</p>

        <NotificationsPushSetup :push="push" />

        <section class="space-y-3">
          <div>
            <h2 class="font-semibold">{{ t('notifications.devices') }}</h2>
            <p class="text-sm text-(--ui-text-muted)">{{ t('notifications.devicesHint') }}</p>
          </div>
          <p v-if="!push.config.value?.subscriptions.length" class="text-sm text-(--ui-text-muted)">{{ t('notifications.devicesEmpty') }}</p>
          <ul v-else class="divide-y divide-(--ui-border) rounded-md border border-(--ui-border)">
            <li v-for="subscription in push.config.value.subscriptions" :key="subscription.id" class="flex items-center gap-3 px-3 py-2">
              <UIcon name="i-lucide-monitor-smartphone" class="size-5 shrink-0 text-(--ui-text-muted)" />
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="truncate text-sm" :title="subscription.userAgent ?? ''">
                    {{ describeDevice(subscription.userAgent) ?? t('notifications.unknownDevice') }}
                  </span>
                  <UBadge v-if="subscription.current" color="success" variant="subtle" size="sm">{{ t('profile.thisDevice') }}</UBadge>
                </div>
                <p v-if="subscription.lastError" class="truncate text-xs text-(--ui-error)" :title="subscription.lastError">{{ subscription.lastError }}</p>
                <p v-else class="text-xs text-(--ui-text-muted)">
                  {{ subscription.lastSuccessAt ? t('notifications.lastDelivered', { time: formatRelative(subscription.lastSuccessAt) }) : t('notifications.neverDelivered') }}
                </p>
              </div>
              <UButton icon="i-lucide-bell-off" color="error" variant="ghost" :aria-label="t('notifications.removeDevice')" :title="t('notifications.removeDevice')" @click="remove(subscription)" />
            </li>
          </ul>
        </section>

        <section v-if="selected" class="space-y-4">
          <h2 class="font-semibold">{{ t('notifications.what') }}</h2>
          <UTabs v-if="workspaceTabs.length > 1" v-model="selected" :items="workspaceTabs" :content="false" size="sm" />
          <NotificationsSettingsForm :key="selected" :workspace-id="selected" :role="selectedRole" />
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
