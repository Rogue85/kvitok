<script setup lang="ts">
import { PasswordSchema, type MeResponse, type SessionDto } from '@kvitok/shared';
import type { FormError, TableColumn } from '@nuxt/ui';

const toast = useToast();
const { me } = useAuth();

function notifyError(error: unknown, fallback: string): void {
  toast.add({ color: 'error', title: error instanceof ApiError ? error.message : fallback });
}

const name = ref(me.value?.user.name ?? '');
const savingName = ref(false);
async function saveName(): Promise<void> {
  savingName.value = true;
  try {
    me.value = await api<MeResponse>('/auth/me', { method: 'PATCH', body: { name: name.value } });
    toast.add({ title: t('profile.saved'), icon: 'i-lucide-check' });
  } catch (e) {
    notifyError(e, t('profile.saveFailed'));
  } finally {
    savingName.value = false;
  }
}

const password = reactive({ current: '', next: '', confirm: '' });
const passwordError = ref<string | null>(null);
function validatePassword(value: typeof password): FormError[] {
  const errors: FormError[] = [];
  const parsed = PasswordSchema.safeParse(value.next);
  if (!parsed.success) errors.push({ name: 'next', message: parsed.error.issues[0]?.message ?? '' });
  if (value.confirm !== value.next) errors.push({ name: 'confirm', message: t('auth.passwordsDiffer') });
  return errors;
}
async function changePassword(): Promise<void> {
  passwordError.value = null;
  try {
    await api('/auth/password', { method: 'POST', body: { currentPassword: password.current, newPassword: password.next } });
    Object.assign(password, { current: '', next: '', confirm: '' });
    toast.add({ title: t('profile.passwordChanged'), icon: 'i-lucide-check' });
    await refreshSessions();
  } catch (e) {
    passwordError.value = e instanceof ApiError ? e.message : t('profile.passwordFailed');
  }
}

const { data: sessions, refresh: refreshSessions, status } = await useAsyncData('sessions', () => api<SessionDto[]>('/auth/sessions'), {
  default: () => [],
});
const columns: TableColumn<SessionDto>[] = [
  { accessorKey: 'userAgent', header: t('profile.device') },
  { accessorKey: 'ip', header: 'IP' },
  { accessorKey: 'lastSeenAt', header: t('profile.lastSeen') },
  { id: 'actions', header: '' },
];
const hasOthers = computed(() => sessions.value.some((s) => !s.current));

const version = useVersion();

async function endSession(session: SessionDto): Promise<void> {
  try {
    await api(`/auth/sessions/${session.id}`, { method: 'DELETE' });
  } catch (e) {
    notifyError(e, t('common.actionFailed'));
  }
  await refreshSessions();
}

async function endOthers(): Promise<void> {
  try {
    await api('/auth/sessions', { method: 'DELETE' });
    toast.add({ title: t('profile.othersEnded'), icon: 'i-lucide-check' });
  } catch (e) {
    notifyError(e, t('common.actionFailed'));
  }
  await refreshSessions();
}
</script>

<template>
  <UDashboardPanel id="profile">
    <template #header>
      <UDashboardNavbar :title="t('nav.profile')" />
    </template>

    <template #body>
      <div class="max-w-xl space-y-8">
        <form class="space-y-4" @submit.prevent="saveName">
          <UFormField label="Email">
            <UInput :model-value="me?.user.email" readonly class="w-full" />
          </UFormField>
          <UFormField :label="t('members.name')" required>
            <UInput v-model="name" autocomplete="name" class="w-full" />
          </UFormField>
          <UButton type="submit" :loading="savingName" :disabled="!name.trim() || name.trim() === me?.user.name">{{ t('common.save') }}</UButton>
        </form>

        <section class="space-y-4">
          <h2 class="font-semibold">{{ t('profile.password') }}</h2>
          <UForm :validate="validatePassword" :state="password" class="space-y-4" @submit="changePassword">
            <UFormField :label="t('profile.currentPassword')" name="current">
              <UInput v-model="password.current" type="password" autocomplete="current-password" class="w-full" />
            </UFormField>
            <UFormField :label="t('auth.newPassword')" name="next" :help="t('auth.passwordHelp')">
              <UInput v-model="password.next" type="password" autocomplete="new-password" class="w-full" />
            </UFormField>
            <UFormField :label="t('auth.confirmPassword')" name="confirm">
              <UInput v-model="password.confirm" type="password" autocomplete="new-password" class="w-full" />
            </UFormField>
            <p class="text-sm text-(--ui-text-muted)">{{ t('profile.passwordHint') }}</p>
            <UAlert v-if="passwordError" color="error" variant="subtle" :title="passwordError" />
            <UButton type="submit" :disabled="!password.current || !password.next">{{ t('profile.changePassword') }}</UButton>
          </UForm>
        </section>
      </div>

      <section class="mt-8 space-y-4">
        <div class="flex items-center justify-between gap-4">
          <h2 class="font-semibold">{{ t('profile.sessions') }}</h2>
          <UButton v-if="hasOthers" color="neutral" variant="soft" icon="i-lucide-log-out" @click="endOthers">{{ t('profile.endOthers') }}</UButton>
        </div>
        <ResponsiveTable :data="sessions" :columns="columns" :loading="status === 'pending'">
          <template #userAgent-cell="{ row }">
            <div class="flex items-center gap-2">
              <span class="max-w-md truncate" :title="row.original.userAgent ?? ''">{{ row.original.userAgent ?? t('profile.unknownDevice') }}</span>
              <UBadge v-if="row.original.current" color="success" variant="subtle">{{ t('profile.thisDevice') }}</UBadge>
            </div>
          </template>
          <template #ip-cell="{ row }">{{ row.original.ip ?? t('common.none') }}</template>
          <template #lastSeenAt-cell="{ row }">{{ formatRelative(row.original.lastSeenAt) }}</template>
          <template #actions-cell="{ row }">
            <UButton
              v-if="!row.original.current"
              icon="i-lucide-log-out"
              color="error"
              variant="ghost"
              :aria-label="t('profile.endSession')"
              @click="endSession(row.original)"
            />
          </template>
        </ResponsiveTable>
      </section>

      <p v-if="version" class="mt-8 text-xs text-(--ui-text-dimmed)">{{ t('profile.version', { version }) }}</p>
    </template>
  </UDashboardPanel>
</template>
