<script setup lang="ts">
import type { DropdownMenuItem, NavigationMenuItem } from '@nuxt/ui';

const route = useRoute();
const { me, logout } = useAuth();

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
  <UDashboardGroup>
    <UDashboardSidebar collapsible resizable>
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
        <div class="flex w-full items-center gap-2">
          <NuxtLink to="/profile" class="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 hover:bg-(--ui-bg-elevated)" :title="t('nav.profile')">
            <UAvatar :alt="me?.user.name" size="sm" />
            <span v-if="!collapsed" class="flex-1 truncate text-sm">{{ me?.user.name }}</span>
          </NuxtLink>
          <UButton icon="i-lucide-log-out" color="neutral" variant="ghost" :aria-label="t('common.logout')" @click="logout" />
        </div>
      </template>
    </UDashboardSidebar>

    <slot />
  </UDashboardGroup>
</template>
