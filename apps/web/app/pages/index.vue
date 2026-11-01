<script setup lang="ts">
definePageMeta({ layout: 'auth' });

const { me, logout } = useAuth();
const first = me.value?.workspaces[0];
if (first) {
  await navigateTo(`/w/${first.workspaceId}/tickets`, { replace: true });
} else if (me.value?.user.isSuperadmin) {
  await navigateTo('/admin/workspaces', { replace: true });
}
</script>

<template>
  <UCard class="w-full max-w-md">
    <template #header>
      <h1 class="text-lg font-semibold">{{ t('workspaceSetup.noWorkspaces') }}</h1>
    </template>

    <p class="text-sm text-(--ui-text-muted)">{{ t('workspaceSetup.askAdmin') }}</p>

    <template #footer>
      <div class="flex justify-between">
        <UButton to="/profile" variant="link" color="neutral">{{ t('nav.profile') }}</UButton>
        <UButton variant="link" color="neutral" @click="logout">{{ t('common.logout') }}</UButton>
      </div>
    </template>
  </UCard>
</template>
