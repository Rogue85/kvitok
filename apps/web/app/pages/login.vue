<script setup lang="ts">
import { LoginSchema, type LoginInput } from '@kvitok/shared';
import type { FormSubmitEvent } from '@nuxt/ui';

definePageMeta({ layout: 'auth', public: true });

const { login } = useAuth();
const route = useRoute();
const state = reactive({ email: '', password: '' });
const error = ref<string | null>(null);
const loading = ref(false);

async function onSubmit(event: FormSubmitEvent<LoginInput>): Promise<void> {
  error.value = null;
  loading.value = true;
  try {
    await login(event.data.email, event.data.password);
    const redirect = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/') ? route.query.redirect : '/';
    await navigateTo(redirect);
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : t('auth.signInFailed');
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <UCard class="w-full max-w-sm">
    <template #header>
      <h1 class="mb-3"><AppLogo class="h-7" /></h1>
      <p class="text-sm text-(--ui-text-muted)">{{ t('auth.subtitle') }}</p>
    </template>

    <UForm :schema="LoginSchema" :state="state" class="space-y-4" @submit="onSubmit">
      <UFormField label="Email" name="email">
        <UInput v-model="state.email" type="email" autocomplete="username" class="w-full" autofocus />
      </UFormField>
      <UFormField :label="t('auth.password')" name="password">
        <UInput v-model="state.password" type="password" autocomplete="current-password" class="w-full" />
      </UFormField>
      <UAlert v-if="error" color="error" variant="subtle" :title="error" />
      <UButton type="submit" block :loading="loading">{{ t('auth.signIn') }}</UButton>
    </UForm>
  </UCard>
</template>
