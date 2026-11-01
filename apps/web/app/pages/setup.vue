<script setup lang="ts">
import { getLocale } from '@kvitok/i18n';
import { SetupSchema, type SetupInput } from '@kvitok/shared';
import type { FormSubmitEvent } from '@nuxt/ui';

definePageMeta({ layout: 'auth', public: true });

const { setup, checkSetup } = useAuth();
if (!(await checkSetup())) {
  await navigateTo('/login', { replace: true });
}

const currencies = currencyItems();
const state = reactive<SetupInput>({
  name: '',
  email: '',
  password: '',
  workspaceName: '',
  currency: getLocale() === 'ru' ? 'RUB' : 'USD',
});
const error = ref<string | null>(null);
const loading = ref(false);

async function onSubmit(event: FormSubmitEvent<SetupInput>): Promise<void> {
  error.value = null;
  loading.value = true;
  try {
    await setup(event.data);
    await navigateTo('/');
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : t('setup.failed');
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <UCard class="w-full max-w-md">
    <template #header>
      <h1 class="mb-3"><AppLogo class="h-7" /></h1>
      <p class="text-sm text-(--ui-text-muted)">{{ t('setup.intro') }}</p>
    </template>

    <UForm :schema="SetupSchema" :state="state" class="space-y-4" @submit="onSubmit">
      <h2 class="text-sm font-semibold">{{ t('setup.admin') }}</h2>
      <UFormField :label="t('members.name')" name="name">
        <UInput v-model="state.name" autocomplete="name" class="w-full" autofocus />
      </UFormField>
      <UFormField label="Email" name="email">
        <UInput v-model="state.email" type="email" autocomplete="username" class="w-full" />
      </UFormField>
      <UFormField :label="t('auth.password')" name="password" :help="t('auth.passwordHelp')">
        <UInput v-model="state.password" type="password" autocomplete="new-password" class="w-full" />
      </UFormField>

      <h2 class="pt-2 text-sm font-semibold">{{ t('setup.workspace') }}</h2>
      <UFormField :label="t('common.name')" name="workspaceName" :help="t('setup.workspaceHelp')">
        <UInput v-model="state.workspaceName" class="w-full" />
      </UFormField>
      <UFormField :label="t('generalSettings.currency')" name="currency" :help="t('generalSettings.currencyHelp')">
        <USelectMenu v-model="state.currency" :items="currencies" value-key="value" class="w-full" />
      </UFormField>

      <UAlert v-if="error" color="error" variant="subtle" :title="error" />
      <UButton type="submit" block :loading="loading">{{ t('setup.submit') }}</UButton>
    </UForm>
  </UCard>
</template>
