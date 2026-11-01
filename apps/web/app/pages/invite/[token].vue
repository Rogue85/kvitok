<script setup lang="ts">
import { PasswordSchema, type PasswordLinkInfoDto } from '@kvitok/shared';
import type { FormError } from '@nuxt/ui';

definePageMeta({ layout: 'auth', public: true, keepSession: true });

const route = useRoute();
const { acceptPasswordLink } = useAuth();
const token = String(route.params.token);

const info = ref<PasswordLinkInfoDto | null>(null);
const invalid = ref<string | null>(null);
try {
  info.value = await api<PasswordLinkInfoDto>(`/password-links/${encodeURIComponent(token)}`);
} catch (e) {
  invalid.value = e instanceof ApiError ? e.message : t('common.error');
}

const state = reactive({ password: '', confirm: '' });
const error = ref<string | null>(null);
const loading = ref(false);

function validate(value: typeof state): FormError[] {
  const errors: FormError[] = [];
  const password = PasswordSchema.safeParse(value.password);
  if (!password.success) errors.push({ name: 'password', message: password.error.issues[0]?.message ?? '' });
  if (value.confirm !== value.password) errors.push({ name: 'confirm', message: t('auth.passwordsDiffer') });
  return errors;
}

async function onSubmit(): Promise<void> {
  error.value = null;
  loading.value = true;
  try {
    await acceptPasswordLink(token, state.password);
    await navigateTo('/');
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : t('passwordLink.failed');
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <UCard class="w-full max-w-sm">
    <template #header>
      <h1 class="mb-3"><AppLogo class="h-7" /></h1>
      <p v-if="info" class="text-sm text-(--ui-text-muted)">
        {{ info.purpose === 'invite' ? t('passwordLink.inviteIntro', { name: info.name }) : t('passwordLink.resetIntro') }}
      </p>
    </template>

    <div v-if="invalid" class="space-y-4">
      <UAlert color="error" variant="subtle" :title="invalid" />
      <UButton to="/login" variant="link" color="neutral">{{ t('auth.signIn') }}</UButton>
    </div>

    <UForm v-else-if="info" :validate="validate" :state="state" class="space-y-4" @submit="onSubmit">
      <UFormField label="Email">
        <UInput :model-value="info.email" readonly autocomplete="username" class="w-full" />
      </UFormField>
      <UFormField :label="t('auth.newPassword')" name="password" :help="t('auth.passwordHelp')">
        <UInput v-model="state.password" type="password" autocomplete="new-password" class="w-full" autofocus />
      </UFormField>
      <UFormField :label="t('auth.confirmPassword')" name="confirm">
        <UInput v-model="state.confirm" type="password" autocomplete="new-password" class="w-full" />
      </UFormField>
      <UAlert v-if="error" color="error" variant="subtle" :title="error" />
      <UButton type="submit" block :loading="loading">{{ t('passwordLink.submit') }}</UButton>
    </UForm>
  </UCard>
</template>
