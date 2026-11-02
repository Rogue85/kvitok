<script setup lang="ts">
import type { WorkspaceDto } from '@kvitok/shared';

const toast = useToast();
const { workspaceId, can } = useWorkspace();
const { fetchMe } = useAuth();
const isAdmin = computed(() => can('admin'));
const { data: workspace } = await useWorkspaceSettings();

const form = reactive({ name: '', currency: 'USD', assignActiveOperator: true, assigneesKeepAccess: true });
watch(
  workspace,
  (value) => {
    if (value) Object.assign(form, { name: value.name, currency: value.currency, ...value.assignment });
  },
  { immediate: true },
);
const changed = computed(
  () =>
    !!workspace.value &&
    (form.name.trim() !== workspace.value.name ||
      form.currency !== workspace.value.currency ||
      form.assignActiveOperator !== workspace.value.assignment.assignActiveOperator ||
      form.assigneesKeepAccess !== workspace.value.assignment.assigneesKeepAccess),
);

const currencies = currencyItems();

const saving = ref(false);
async function save(): Promise<void> {
  saving.value = true;
  try {
    workspace.value = await api<WorkspaceDto>(`/workspaces/${workspaceId.value}`, {
      method: 'PATCH',
      body: {
        name: form.name,
        currency: form.currency,
        assignment: { assignActiveOperator: form.assignActiveOperator, assigneesKeepAccess: form.assigneesKeepAccess },
      },
    });
    // The name is in the workspace switcher.
    await fetchMe();
    toast.add({ title: t('generalSettings.saved'), icon: 'i-lucide-check' });
  } catch (e) {
    toast.add({ color: 'error', title: e instanceof ApiError ? e.message : t('generalSettings.saveFailed') });
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UDashboardPanel id="general-settings">
    <template #header>
      <UDashboardNavbar :title="t('nav.general')" />
    </template>

    <template #body>
      <form class="max-w-xl space-y-5" @submit.prevent="save">
        <p class="text-sm text-(--ui-text-muted)">{{ t('generalSettings.intro') }}</p>
        <UFormField :label="t('common.name')" required>
          <UInput v-model="form.name" :disabled="!isAdmin" class="w-full" />
        </UFormField>
        <UFormField :label="t('generalSettings.currency')" :help="t('generalSettings.currencyHelp')">
          <USelectMenu v-model="form.currency" :items="currencies" value-key="value" :disabled="!isAdmin" class="w-full" />
        </UFormField>
        <UAlert
          v-if="workspace && form.currency !== workspace.currency"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :description="t('generalSettings.currencyChanged')"
        />
        <USeparator />
        <h3 class="text-sm font-semibold">{{ t('generalSettings.assignment') }}</h3>
        <USwitch
          v-model="form.assignActiveOperator"
          :disabled="!isAdmin"
          :label="t('generalSettings.assignActiveOperator')"
          :description="t('generalSettings.assignActiveOperatorHelp')"
        />
        <USwitch
          v-model="form.assigneesKeepAccess"
          :disabled="!isAdmin"
          :label="t('generalSettings.assigneesKeepAccess')"
          :description="t('generalSettings.assigneesKeepAccessHelp')"
        />
        <UAlert
          v-if="workspace && workspace.assignment.assigneesKeepAccess && !form.assigneesKeepAccess"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :description="t('generalSettings.assigneesKeepAccessOff')"
        />
        <UButton v-if="isAdmin" type="submit" :loading="saving" :disabled="!changed || !form.name.trim()">{{ t('common.save') }}</UButton>
      </form>
    </template>
  </UDashboardPanel>
</template>
