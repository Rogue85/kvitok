<script setup lang="ts">
import { CreateWorkspaceSchema, type CreateWorkspaceInput, type WorkspaceDto } from '@kvitok/shared';
import type { FormSubmitEvent } from '@nuxt/ui';

definePageMeta({ layout: 'auth' });

const { me, fetchMe, logout } = useAuth();
const first = me.value?.memberships[0];
if (first) {
  await navigateTo(`/w/${first.workspaceId}/tickets`, { replace: true });
}

const state = reactive({ name: '', slug: '' });
const error = ref<string | null>(null);

async function onCreate(event: FormSubmitEvent<CreateWorkspaceInput>): Promise<void> {
  error.value = null;
  try {
    const workspace = await api<WorkspaceDto>('/workspaces', { method: 'POST', body: event.data });
    await fetchMe();
    await navigateTo(`/w/${workspace.id}/tickets`);
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : t('workspaceSetup.createFailed');
  }
}
</script>

<template>
  <UCard class="w-full max-w-md">
    <template #header>
      <h1 class="text-lg font-semibold">{{ t('workspaceSetup.noWorkspaces') }}</h1>
    </template>

    <UForm v-if="me?.user.isSuperadmin" :schema="CreateWorkspaceSchema" :state="state" class="space-y-4" @submit="onCreate">
      <UFormField :label="t('common.name')" name="name">
        <UInput v-model="state.name" class="w-full" />
      </UFormField>
      <UFormField label="Slug" name="slug" :help="t('workspaceSetup.slugHelp')">
        <UInput v-model="state.slug" class="w-full" />
      </UFormField>
      <UAlert v-if="error" color="error" variant="subtle" :title="error" />
      <UButton type="submit" block>{{ t('workspaceSetup.create') }}</UButton>
    </UForm>
    <p v-else class="text-sm text-(--ui-text-muted)">{{ t('workspaceSetup.askAdmin') }}</p>

    <template #footer>
      <UButton variant="link" color="neutral" @click="logout">{{ t('common.logout') }}</UButton>
    </template>
  </UCard>
</template>
