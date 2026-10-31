<script setup lang="ts">
import type { AgentRunDetailDto, AgentSettingsDto, LlmModel, LlmProviderDto, TicketListDto } from '@kvitok/shared';

const toast = useToast();
const { workspaceId, can } = useWorkspace();
const isAdmin = computed(() => can('admin'));
const base = computed(() => `/workspaces/${workspaceId.value}`);

const { data: settings, refresh: refreshSettings } = await useAsyncData(() => `agent-settings:${workspaceId.value}`, () => api<AgentSettingsDto>(`${base.value}/agent/settings`));
const { data: providers, refresh: refreshProviders } = await useAsyncData(
  () => `llm-providers:${workspaceId.value}`,
  () => (isAdmin.value ? api<LlmProviderDto[]>(`${base.value}/llm-providers`) : Promise.resolve([])),
  { default: () => [] },
);

function notifyError(e: unknown, fallback: string): void {
  const details = e instanceof ApiError && Array.isArray(e.details) ? (e.details as Array<{ message: string }>).map((d) => d.message).join('; ') : '';
  toast.add({ color: 'error', title: e instanceof ApiError ? e.message : fallback, description: details || undefined });
}

/* Agent settings */
const form = reactive<AgentSettingsDto>({
  enabled: false,
  providerId: null,
  model: null,
  policy: '',
  playbookMode: 'on_demand',
  maxToolCalls: 8,
  maxOutputTokens: 4000,
  temperature: 0.2,
  confidenceThreshold: 0.6,
  debounceSeconds: 30,
});
watch(settings, (value) => value && Object.assign(form, value), { immediate: true });
/** Nuxt UI selects work with undefined, the settings store null. */
function nullable<K extends 'providerId' | 'model'>(key: K) {
  return computed({
    get: () => form[key] ?? undefined,
    set: (value: string | undefined) => {
      form[key] = value || null;
    },
  });
}
const providerIdModel = nullable('providerId');
const modelModel = nullable('model');
const providerItems = computed(() => providers.value.map((p) => ({ label: p.name, value: p.id })));
const modelItems = computed(() => (providers.value.find((p) => p.id === form.providerId)?.models ?? []).map((m) => m.id));

async function saveSettings(): Promise<void> {
  try {
    settings.value = await api<AgentSettingsDto>(`${base.value}/agent/settings`, { method: 'PUT', body: form });
    toast.add({ color: 'success', title: t('agentSettings.saved') });
  } catch (e) {
    notifyError(e, t('ticket.saveFailed'));
    await refreshSettings();
  }
}

/* Check on a ticket: an analysis by the chosen model without applying it or changing the settings */
const trial = reactive({ ticket: '', providerId: undefined as string | undefined, model: undefined as string | undefined });
const trialModels = computed(() => (providers.value.find((p) => p.id === trial.providerId)?.models ?? []).map((m) => m.id));
watch(
  () => trial.providerId,
  () => {
    trial.model = trialModels.value[0];
  },
);
const trialRunning = ref(false);
const trialResult = ref<{ run: AgentRunDetailDto; result: Record<string, unknown> | null } | null>(null);
async function runTrial(): Promise<void> {
  trialRunning.value = true;
  trialResult.value = null;
  try {
    const list = await api<TicketListDto>(`${base.value}/tickets?q=${encodeURIComponent(`#T-${trial.ticket.replace(/\D/g, '')}`)}&pageSize=1`);
    const ticket = list.items[0];
    if (!ticket) {
      toast.add({ color: 'warning', title: t('ticket.notFound') });
      return;
    }
    trialResult.value = await api(`${base.value}/tickets/${ticket.id}/agent/dry-run`, {
      method: 'POST',
      body: { ...(trial.providerId ? { providerId: trial.providerId } : {}), ...(trial.model ? { model: trial.model } : {}) },
    });
  } catch (e) {
    notifyError(e, t('agentSettings.trialFailed'));
  } finally {
    trialRunning.value = false;
  }
}
const trialSeconds = computed(() => {
  const run = trialResult.value?.run;
  return run?.startedAt && run.finishedAt ? ((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000).toFixed(1) : null;
});

/* Providers */
const providerOpen = ref(false);
const providerForm = reactive({
  id: null as string | null,
  name: '',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  tools: true,
  models: [] as Array<{ id: string; inputPerMillion: number | null; outputPerMillion: number | null; currency: string }>,
});
function editProvider(provider: LlmProviderDto | null): void {
  Object.assign(providerForm, {
    id: provider?.id ?? null,
    name: provider?.name ?? '',
    baseUrl: provider?.baseUrl ?? 'https://api.openai.com/v1',
    apiKey: '',
    tools: provider?.capabilities.tools ?? true,
    models: (provider?.models ?? [{ id: '' } as LlmModel]).map((m) => ({
      id: m.id,
      inputPerMillion: m.inputPerMillion ?? null,
      outputPerMillion: m.outputPerMillion ?? null,
      currency: m.currency ?? 'USD',
    })),
  });
  providerOpen.value = true;
}
async function saveProvider(): Promise<void> {
  const body = {
    name: providerForm.name,
    baseUrl: providerForm.baseUrl,
    ...(providerForm.apiKey ? { apiKey: providerForm.apiKey } : {}),
    capabilities: { tools: providerForm.tools, vision: false },
    models: providerForm.models
      .filter((m) => m.id.trim())
      .map((m) => ({
        id: m.id.trim(),
        ...(m.inputPerMillion !== null ? { inputPerMillion: m.inputPerMillion } : {}),
        ...(m.outputPerMillion !== null ? { outputPerMillion: m.outputPerMillion } : {}),
        currency: m.currency || 'USD',
      })),
  };
  try {
    if (providerForm.id) {
      await api(`${base.value}/llm-providers/${providerForm.id}`, { method: 'PATCH', body });
    } else {
      await api(`${base.value}/llm-providers`, { method: 'POST', body });
    }
    providerOpen.value = false;
    await refreshProviders();
  } catch (e) {
    notifyError(e, t('agentSettings.providerSaveFailed'));
  }
}
const testing = ref<string | null>(null);
async function testProvider(provider: LlmProviderDto): Promise<void> {
  const model = provider.models[0]?.id;
  if (!model) {
    toast.add({ color: 'warning', title: t('agentSettings.addModel') });
    return;
  }
  testing.value = provider.id;
  try {
    const result = await api<{ ok: boolean; reply?: string; error?: string; latencyMs: number }>(`${base.value}/llm-providers/${provider.id}/test`, { method: 'POST', body: { model } });
    toast.add({
      color: result.ok ? 'success' : 'error',
      title: result.ok ? t('agentSettings.providerResponds', { model, ms: result.latencyMs }) : t('agentSettings.providerError'),
      description: result.ok ? result.reply : result.error,
    });
  } finally {
    testing.value = null;
  }
}
async function removeProvider(provider: LlmProviderDto): Promise<void> {
  try {
    await api(`${base.value}/llm-providers/${provider.id}`, { method: 'DELETE' });
    await refreshProviders();
  } catch (e) {
    notifyError(e, t('agentSettings.deleteFailed'));
  }
}
</script>

<template>
  <UDashboardPanel id="agent-settings">
    <template #header>
      <UDashboardNavbar :title="t('nav.agent')">
        <template #right>
          <UButton v-if="isAdmin" icon="i-lucide-save" :label="t('common.save')" @click="saveSettings" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="grid max-w-5xl gap-6 lg:grid-cols-[1fr_22rem]">
        <div class="space-y-5">
          <UCard>
            <div class="flex items-center justify-between gap-4">
              <div>
                <p class="font-medium">{{ t('agentSettings.enabledTitle') }}</p>
                <p class="text-sm text-(--ui-text-muted)">{{ t('agentSettings.enabledDescription') }}</p>
              </div>
              <USwitch v-model="form.enabled" :disabled="!isAdmin" />
            </div>
          </UCard>

          <UCard>
            <template #header><p class="font-medium">{{ t('agentSettings.model') }}</p></template>
            <div class="grid grid-cols-2 gap-3">
              <UFormField :label="t('agentSettings.provider')">
                <USelect v-model="providerIdModel" :items="providerItems" :placeholder="t('agentSettings.notSelected')" class="w-full" :disabled="!isAdmin" />
              </UFormField>
              <UFormField :label="t('agentSettings.model')">
                <UInputMenu v-model="modelModel" :items="modelItems" create-item placeholder="gpt-4.1-mini" class="w-full" :disabled="!isAdmin" @create="(v: string) => (modelModel = v)" />
              </UFormField>
              <UFormField :label="t('agentSettings.temperature')"><UInputNumber v-model="form.temperature" :min="0" :max="2" :step="0.1" class="w-full" :disabled="!isAdmin" /></UFormField>
            </div>
          </UCard>

          <UCard>
            <template #header>
              <p class="font-medium">{{ t('agentSettings.policy') }}</p>
              <p class="text-sm text-(--ui-text-muted)">{{ t('agentSettings.policyHelp') }}</p>
            </template>
            <UTextarea
              v-model="form.policy"
              autoresize
              :rows="8"
              class="w-full"
              :disabled="!isAdmin"
              :placeholder="t('agentSettings.policyPlaceholder')"
            />
          </UCard>

          <UCard>
            <template #header><p class="font-medium">{{ t('agentSettings.behavior') }}</p></template>
            <div class="grid grid-cols-2 gap-3">
              <UFormField :label="t('nav.playbooks')" :help="t('agentSettings.playbooksHelp')">
                <USelect
                  v-model="form.playbookMode"
                  :items="[
                    { label: t('agentSettings.playbooksOnDemand'), value: 'on_demand' },
                    { label: t('agentSettings.playbooksInline'), value: 'inline' },
                  ]"
                  class="w-full"
                  :disabled="!isAdmin"
                />
              </UFormField>
              <UFormField :label="t('agentSettings.threshold')" :help="t('agentSettings.thresholdHelp')">
                <UInputNumber v-model="form.confidenceThreshold" :min="0" :max="1" :step="0.05" class="w-full" :disabled="!isAdmin" />
              </UFormField>
              <UFormField :label="t('agentSettings.debounce')" :help="t('agentSettings.debounceHelp')">
                <UInputNumber v-model="form.debounceSeconds" :min="0" :max="600" class="w-full" :disabled="!isAdmin" />
              </UFormField>
              <UFormField :label="t('agentSettings.maxToolCalls')"><UInputNumber v-model="form.maxToolCalls" :min="1" :max="30" class="w-full" :disabled="!isAdmin" /></UFormField>
              <UFormField :label="t('agentSettings.maxOutputTokens')" :help="t('agentSettings.maxOutputTokensHelp')"><UInputNumber v-model="form.maxOutputTokens" :min="256" :max="32000" :step="256" class="w-full" :disabled="!isAdmin" /></UFormField>
            </div>
          </UCard>
        </div>

        <div v-if="isAdmin" class="space-y-3">
          <UCard :ui="{ body: 'p-3 sm:p-3' }">
            <p class="font-medium">{{ t('rules.checkOnTicket') }}</p>
            <p class="mb-2 text-xs text-(--ui-text-muted)">{{ t('agentSettings.trialHelp') }}</p>
            <div class="space-y-2">
              <UInput v-model="trial.ticket" placeholder="T-12" size="sm" class="w-full" />
              <USelect v-model="trial.providerId" :items="providerItems" :placeholder="t('agentSettings.providerFromSettings')" size="sm" class="w-full" />
              <USelect v-model="trial.model" :items="trialModels" :placeholder="t('agentSettings.model')" size="sm" class="w-full" :disabled="!trial.providerId" />
              <UButton size="sm" block icon="i-lucide-flask-conical" :loading="trialRunning" :disabled="!trial.ticket" @click="runTrial">{{ t('agentSettings.run') }}</UButton>
            </div>
            <div v-if="trialResult" class="mt-3 space-y-2 text-xs">
              <p class="text-(--ui-text-muted)">
                {{ trialResult.run.model }} · {{ t('agentSettings.seconds', { seconds: trialSeconds ?? '—' }) }} · {{ t('agentRuns.stepTokens', { input: trialResult.run.tokensIn, output: trialResult.run.tokensOut }) }}<template v-if="trialResult.run.cost !== null"> · {{ trialResult.run.cost }} {{ trialResult.run.currency }}</template>
              </p>
              <UAlert v-if="trialResult.run.error" color="error" variant="subtle" :title="trialResult.run.error" />
              <template v-if="trialResult.result">
                <p><b>{{ t('agentMessage.departmentLabel') }}</b> {{ trialResult.result.department ?? '—' }} ({{ Math.round(Number(trialResult.result.confidence) * 100) }}%)</p>
                <p>{{ trialResult.result.summary }}</p>
                <details>
                  <summary class="cursor-pointer text-(--ui-text-muted)">{{ t('agentSettings.fullResult') }}</summary>
                  <pre class="mt-1 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-(--ui-bg-muted) p-2">{{ JSON.stringify(trialResult.result, null, 2) }}</pre>
                </details>
              </template>
            </div>
          </UCard>

          <div class="flex items-center justify-between">
            <p class="font-medium">{{ t('agentSettings.providers') }}</p>
            <UButton size="xs" icon="i-lucide-plus" variant="soft" @click="editProvider(null)">{{ t('common.add') }}</UButton>
          </div>
          <p class="text-xs text-(--ui-text-muted)">{{ t('agentSettings.providersHelp') }}</p>
          <UCard v-for="provider in providers" :key="provider.id" :ui="{ body: 'p-3 sm:p-3' }">
            <p class="font-medium">{{ provider.name }}</p>
            <p class="truncate text-xs text-(--ui-text-muted)">{{ provider.baseUrl }}</p>
            <p class="mt-1 text-xs">{{ provider.models.map((m) => m.id).join(', ') || t('agentSettings.noModels') }}</p>
            <div class="mt-1 flex gap-1">
              <UBadge v-if="!provider.hasApiKey" color="warning" variant="subtle" size="sm">{{ t('agentSettings.noKey') }}</UBadge>
              <UBadge v-if="!provider.capabilities.tools" color="neutral" variant="subtle" size="sm">{{ t('agentSettings.jsonMode') }}</UBadge>
            </div>
            <div class="mt-2 flex gap-1">
              <UButton size="xs" variant="soft" @click="editProvider(provider)">{{ t('common.edit') }}</UButton>
              <UButton size="xs" variant="soft" color="neutral" :loading="testing === provider.id" @click="testProvider(provider)">{{ t('rules.check') }}</UButton>
              <UButton size="xs" variant="ghost" color="error" icon="i-lucide-trash-2" @click="removeProvider(provider)" />
            </div>
          </UCard>
        </div>
      </div>

      <UModal v-model:open="providerOpen" :title="providerForm.id ? t('agentSettings.provider') : t('agentSettings.newProvider')" :ui="{ content: 'max-w-2xl' }">
        <template #body>
          <form id="provider-form" class="space-y-4" @submit.prevent="saveProvider">
            <div class="grid grid-cols-2 gap-3">
              <UFormField :label="t('common.name')" required><UInput v-model="providerForm.name" placeholder="OpenAI" class="w-full" /></UFormField>
              <UFormField label="Base URL" required><UInput v-model="providerForm.baseUrl" class="w-full" /></UFormField>
              <UFormField :label="t('agentSettings.apiKey')" :help="providerForm.id ? t('agentSettings.keepCurrent') : undefined" class="col-span-2">
                <UInput v-model="providerForm.apiKey" type="password" autocomplete="off" class="w-full" />
              </UFormField>
            </div>
            <UCheckbox v-model="providerForm.tools" :label="t('agentSettings.supportsTools')" />
            <div class="space-y-2">
              <p class="text-sm font-medium">{{ t('agentSettings.modelsAndPrices') }}</p>
              <div v-for="(model, index) in providerForm.models" :key="index" class="grid grid-cols-[2fr_1fr_1fr_5rem_auto] gap-2">
                <UInput v-model="model.id" placeholder="gpt-4.1-mini" size="sm" />
                <UInputNumber v-model="model.inputPerMillion" :placeholder="t('agentSettings.priceInput')" size="sm" :min="0" :step="0.1" />
                <UInputNumber v-model="model.outputPerMillion" :placeholder="t('agentSettings.priceOutput')" size="sm" :min="0" :step="0.1" />
                <UInput v-model="model.currency" size="sm" />
                <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="sm" @click="providerForm.models.splice(index, 1)" />
              </div>
              <UButton icon="i-lucide-plus" size="xs" variant="soft" @click="providerForm.models.push({ id: '', inputPerMillion: null, outputPerMillion: null, currency: 'USD' })">{{ t('agentSettings.model') }}</UButton>
            </div>
          </form>
        </template>
        <template #footer>
          <UButton color="neutral" variant="ghost" @click="providerOpen = false">{{ t('common.cancel') }}</UButton>
          <UButton type="submit" form="provider-form">{{ t('common.save') }}</UButton>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
