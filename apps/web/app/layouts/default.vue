<script setup lang="ts">
import type { DropdownMenuItem, NavigationMenuItem } from '@nuxt/ui';

const route = useRoute();
const { me, logout, fetchMe } = useAuth();
const toast = useToast();

/* Pages outside a workspace (profile, administration) keep the workspace the user came from. */
const lastWorkspaceId = useState<string | null>('workspace:last', () => null);
watch(
  () => route.params.workspaceId,
  (id) => {
    if (typeof id === 'string' && id) lastWorkspaceId.value = id;
  },
  { immediate: true },
);
const current = computed(() => {
  const list = me.value?.workspaces ?? [];
  return list.find((w) => w.workspaceId === lastWorkspaceId.value) ?? list[0] ?? null;
});

/** Departments that hand tickets out in turn give them only to members who accept tickets; viewers take none. */
const canAccept = computed(() => current.value !== null && current.value.isMember && current.value.role !== 'viewer');
/** The switch moves at once and waits for the server, so a second click does not undo the first. */
const acceptingPending = ref<boolean | null>(null);
const accepting = computed(() => canAccept.value && (acceptingPending.value ?? current.value?.acceptingTickets ?? false));
async function setAccepting(value: boolean): Promise<void> {
  if (!current.value || !me.value) return;
  acceptingPending.value = value;
  try {
    await api(`/workspaces/${current.value.workspaceId}/members/${me.value.user.id}/accepting-tickets`, { method: 'PUT', body: { accepting: value } });
    await fetchMe();
  } catch (error) {
    toast.add({ color: 'error', title: toApiError(error).message });
  } finally {
    acceptingPending.value = null;
  }
}

const workspaceItems = computed<DropdownMenuItem[]>(() =>
  (me.value?.workspaces ?? []).map((w) => ({
    label: w.workspaceName,
    icon: w.isMember ? 'i-lucide-building-2' : 'i-lucide-shield',
    description: w.isMember ? undefined : t('adminWorkspaces.notMember'),
    to: `/w/${w.workspaceId}/tickets`,
  })),
);

const navItems = computed<NavigationMenuItem[]>(() => {
  if (!current.value) return [];
  const base = `/w/${current.value.workspaceId}`;
  return [
    { label: t('nav.tickets'), icon: 'i-lucide-inbox', to: `${base}/tickets` },
    { label: t('nav.analytics'), icon: 'i-lucide-chart-column', to: `${base}/analytics` },
    {
      label: t('nav.settings'),
      icon: 'i-lucide-settings',
      defaultOpen: true,
      children: [
        { label: t('nav.general'), to: `${base}/settings/general` },
        { label: t('nav.members'), to: `${base}/settings/members` },
        { label: t('nav.channels'), to: `${base}/settings/channels` },
        { label: t('nav.integrations'), to: `${base}/settings/integrations` },
        { label: t('nav.departments'), to: `${base}/settings/departments` },
        { label: t('nav.fields'), to: `${base}/settings/fields` },
        { label: t('nav.agent'), to: `${base}/settings/agent` },
        { label: t('nav.playbooks'), to: `${base}/settings/playbooks` },
        { label: t('nav.rules'), to: `${base}/settings/rules` },
        { label: t('nav.identification'), to: `${base}/settings/identification` },
        { label: t('nav.audit'), to: `${base}/settings/audit` },
        { label: t('nav.tokens'), to: `${base}/settings/tokens` },
      ],
    },
  ];
});

/** Phones and tablets: the main sections stay under the thumb, the rest of the menu opens from "More". */
const sidebarOpen = ref(false);
const tabBar = computed(() => !route.meta.hideTabBar);
const tabs = computed(() => {
  const base = current.value ? `/w/${current.value.workspaceId}` : null;
  return [
    ...(base
      ? [
          { label: t('nav.tickets'), icon: 'i-lucide-inbox', to: `${base}/tickets` },
          { label: t('nav.analytics'), icon: 'i-lucide-chart-column', to: `${base}/analytics` },
        ]
      : []),
    { label: t('nav.notifications'), icon: 'i-lucide-bell', to: '/notifications' },
  ];
});

const adminItems = computed<NavigationMenuItem[]>(() =>
  me.value?.user.isSuperadmin
    ? [
        {
          label: t('nav.administration'),
          icon: 'i-lucide-shield',
          defaultOpen: route.path.startsWith('/admin'),
          children: [
            { label: t('nav.users'), to: '/admin/users' },
            { label: t('nav.workspaces'), to: '/admin/workspaces' },
          ],
        },
      ]
    : [],
);
</script>

<template>
  <UDashboardGroup
    class="pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]"
    :class="tabBar ? 'pb-[calc(3.5rem+env(safe-area-inset-bottom))] lg:pb-0' : 'pb-[env(safe-area-inset-bottom)]'"
  >
    <UDashboardSidebar
      v-model:open="sidebarOpen"
      collapsible
      resizable
      :menu="{ ui: { content: 'pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]' } }"
    >
      <template #header="{ collapsed }">
        <div class="flex items-baseline gap-2 px-2.5">
          <NuxtLink :to="current ? `/w/${current.workspaceId}/tickets` : '/'" class="flex items-center">
            <AppMark v-if="collapsed" class="size-6" />
            <AppLogo v-else class="h-5" />
          </NuxtLink>
          <AppVersion v-if="!collapsed" />
        </div>
      </template>

      <template #default="{ collapsed }">
        <UDropdownMenu v-if="current" :items="workspaceItems" :content="{ align: 'start' }" class="w-full">
          <UButton
            color="neutral"
            variant="ghost"
            :icon="current.isMember ? 'i-lucide-building-2' : 'i-lucide-shield'"
            :label="collapsed ? undefined : current.workspaceName"
            trailing-icon="i-lucide-chevrons-up-down"
            block
            :square="collapsed"
          />
        </UDropdownMenu>
        <UNavigationMenu :items="navItems" :collapsed="collapsed" orientation="vertical" />
        <UNavigationMenu v-if="adminItems.length" :items="adminItems" :collapsed="collapsed" orientation="vertical" class="mt-auto" />
      </template>

      <template #footer="{ collapsed }">
        <div class="flex w-full flex-col gap-2">
          <UTooltip v-if="canAccept && !collapsed" :text="t('nav.acceptingTicketsHelp')">
            <USwitch
              :model-value="accepting"
              :disabled="acceptingPending !== null"
              size="sm"
              :label="t(accepting ? 'nav.acceptingTickets' : 'nav.notAcceptingTickets')"
              class="px-1"
              @update:model-value="setAccepting"
            />
          </UTooltip>
          <div class="flex w-full items-center gap-2">
            <NuxtLink to="/profile" class="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 hover:bg-(--ui-bg-elevated)" :title="t('nav.profile')">
              <UChip :show="canAccept" :color="accepting ? 'success' : 'neutral'" inset position="bottom-right">
                <UAvatar :alt="me?.user.name" size="sm" />
              </UChip>
              <span v-if="!collapsed" class="flex-1 truncate text-sm">{{ me?.user.name }}</span>
            </NuxtLink>
            <UButton
              v-if="!collapsed"
              to="/notifications"
              icon="i-lucide-bell"
              color="neutral"
              variant="ghost"
              :aria-label="t('nav.notifications')"
              :title="t('nav.notifications')"
            />
            <UButton icon="i-lucide-log-out" color="neutral" variant="ghost" :aria-label="t('common.logout')" @click="logout" />
          </div>
        </div>
      </template>
    </UDashboardSidebar>

    <slot />

    <nav
      v-if="tabBar"
      class="fixed inset-x-0 bottom-0 z-40 flex border-t border-(--ui-border) bg-(--ui-bg) pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] lg:hidden"
    >
      <NuxtLink
        v-for="tab in tabs"
        :key="tab.to"
        :to="tab.to"
        class="flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px]"
        :class="route.path.startsWith(tab.to) ? 'text-(--ui-primary)' : 'text-(--ui-text-muted)'"
      >
        <UIcon :name="tab.icon" class="size-5" />
        <span>{{ tab.label }}</span>
      </NuxtLink>
      <button
        type="button"
        class="flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px]"
        :class="sidebarOpen ? 'text-(--ui-primary)' : 'text-(--ui-text-muted)'"
        @click="sidebarOpen = true"
      >
        <UIcon name="i-lucide-menu" class="size-5" />
        <span>{{ t('nav.more') }}</span>
      </button>
    </nav>
  </UDashboardGroup>
</template>
