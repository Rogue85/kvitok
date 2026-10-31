<script setup lang="ts">
import type { DropdownMenuItem, NavigationMenuItem } from '@nuxt/ui';

const { me, logout } = useAuth();
const { workspaceId, membership } = useWorkspace();

const workspaceItems = computed<DropdownMenuItem[]>(() =>
  (me.value?.memberships ?? []).map((m) => ({
    label: m.workspaceName,
    icon: 'i-lucide-building-2',
    to: `/w/${m.workspaceId}/tickets`,
  })),
);

const navItems = computed<NavigationMenuItem[]>(() => {
  const base = `/w/${workspaceId.value}`;
  return [
    { label: t('nav.tickets'), icon: 'i-lucide-inbox', to: `${base}/tickets` },
    {
      label: t('nav.settings'),
      icon: 'i-lucide-settings',
      defaultOpen: true,
      children: [
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
</script>

<template>
  <UDashboardGroup>
    <UDashboardSidebar collapsible resizable>
      <template #header="{ collapsed }">
        <NuxtLink :to="`/w/${workspaceId}/tickets`" class="flex items-center px-2.5">
          <AppMark v-if="collapsed" class="size-6" />
          <AppLogo v-else class="h-5" />
        </NuxtLink>
      </template>

      <template #default="{ collapsed }">
        <UDropdownMenu :items="workspaceItems" :content="{ align: 'start' }" class="w-full">
          <UButton
            color="neutral"
            variant="ghost"
            icon="i-lucide-building-2"
            :label="collapsed ? undefined : (membership?.workspaceName ?? 'Workspace')"
            trailing-icon="i-lucide-chevrons-up-down"
            block
            :square="collapsed"
          />
        </UDropdownMenu>
        <UNavigationMenu :items="navItems" :collapsed="collapsed" orientation="vertical" />
      </template>

      <template #footer="{ collapsed }">
        <div class="flex w-full items-center gap-2">
          <UAvatar :alt="me?.user.name" size="sm" />
          <span v-if="!collapsed" class="flex-1 truncate text-sm">{{ me?.user.name }}</span>
          <UButton icon="i-lucide-log-out" color="neutral" variant="ghost" :aria-label="t('common.logout')" @click="logout" />
        </div>
      </template>
    </UDashboardSidebar>

    <slot />
  </UDashboardGroup>
</template>
