<script setup lang="ts">
import {
  CUSTOMER_FROM,
  NAME_IDENTITY,
  type CustomerFrom,
  type IdentificationCheckDto,
  type IdentificationRuleDto,
  type IdentificationSettingsDto,
  type IdentityExtract,
  type IdentityTrust,
  type IntegrationDto,
  type TicketListDto,
  type TrustSender,
} from '@kvitok/shared';

const toast = useToast();
const { workspaceId, can } = useWorkspace();
const isAdmin = computed(() => can('admin'));
const base = computed(() => `/workspaces/${workspaceId.value}/identification`);

const { data: rules, refresh } = await useAsyncData(() => `identification-rules:${workspaceId.value}`, () => api<IdentificationRuleDto[]>(`${base.value}/rules`), { default: () => [] });
const { data: settings, refresh: refreshSettings } = await useAsyncData(() => `identification-settings:${workspaceId.value}`, () => api<IdentificationSettingsDto>(`${base.value}/settings`));
const { data: integrations, refresh: refreshIntegrations } = await useAsyncData(
  () => `integrations:${workspaceId.value}`,
  () => api<IntegrationDto[]>(`/workspaces/${workspaceId.value}/integrations`),
  { default: () => [] },
);

/* The email sender */
const TRUST_SENDER_ITEMS = (['always', 'authenticated'] as const).map((value) => ({
  value,
  label: t(`identification.trustSender.${value}.label`),
  description: t(`identification.trustSender.${value}.description`),
}));
async function saveTrustSender(value: TrustSender): Promise<void> {
  try {
    await api(`${base.value}/settings`, { method: 'PATCH', body: { trustSender: value } });
    toast.add({ title: t('identification.saved'), icon: 'i-lucide-check' });
  } catch (e) {
    toast.add({ color: 'error', title: e instanceof ApiError ? e.message : t('ticket.saveFailed') });
  }
  await refreshSettings();
}

/* Rules */
const CUSTOMER_FROM_ITEMS = CUSTOMER_FROM.map((value) => ({ value, label: t(`identification.customerFrom.${value}.label`), description: t(`identification.customerFrom.${value}.description`) }));
const TRUST_ITEMS = (['claimed', 'trusted'] as const).map((value) => ({ value, label: t(`identification.trust.${value}`) }));
const SOURCE_ITEMS = [
  { value: 'body', label: t('identification.extractSource.body') },
  { value: 'subject', label: t('identification.extractSource.subject') },
  { value: 'header', label: t('identification.extractSource.header') },
];
const fieldPaths = ['from.email', 'from.domain', 'reply_to.email', 'reply_to.domain', 'subject', 'body', 'channel.id', 'channel.type', 'sender.authenticated', 'header.', 'metadata.'];
/** Identity types the integrations resolve by, plus the customer name. */
const identityTypes = computed(() => {
  const types = new Map<string, string>([[NAME_IDENTITY, t('identification.nameType')]]);
  for (const integration of integrations.value) {
    for (const identity of integration.manifest?.identityTypes ?? []) {
      if (!types.has(identity.type)) types.set(identity.type, identityLabel(identity.type, integration.manifest!.identityTypes));
    }
  }
  for (const type of ['email', 'phone']) if (!types.has(type)) types.set(type, identityLabel(type));
  return [...types].map(([value, label]) => ({ value, label: `${label} (${value})` }));
});

interface ExtractRow { identityType: string; source: 'body' | 'subject' | 'header'; header: string; pattern: string; trust: IdentityTrust }
const toRow = (e: IdentityExtract): ExtractRow => ({
  identityType: e.identityType,
  source: e.source.startsWith('header:') ? 'header' : (e.source as 'body' | 'subject'),
  header: e.source.startsWith('header:') ? e.source.slice('header:'.length) : '',
  pattern: e.pattern,
  trust: e.trust,
});
const fromRow = (row: ExtractRow): IdentityExtract => ({
  identityType: row.identityType.trim(),
  source: row.source === 'header' ? `header:${row.header.trim()}` : row.source,
  pattern: row.pattern,
  trust: row.trust,
});
const emptyRow = (): ExtractRow => ({ identityType: 'phone', source: 'body', header: '', pattern: '', trust: 'claimed' });

const open = ref(false);
const form = reactive({
  id: null as string | null,
  name: '',
  conditions: conditionsDraft({ all: [] }),
  customerFrom: 'sender' as CustomerFrom,
  extract: [] as ExtractRow[],
  stop: false,
  enabled: true,
  position: 0,
});

function edit(rule: IdentificationRuleDto | null): void {
  Object.assign(form, {
    id: rule?.id ?? null,
    name: rule?.name ?? '',
    conditions: conditionsDraft(rule?.conditions ?? { all: [{ field: 'from.email', op: 'eq', value: '' }] }),
    customerFrom: rule?.customerFrom ?? 'sender',
    extract: (rule?.extract ?? []).map(toRow),
    stop: rule?.stop ?? false,
    enabled: rule?.enabled ?? true,
    position: rule?.position ?? (rules.value.length + 1) * 10,
  });
  open.value = true;
}

/** Typical rules to start from: a form email with labelled lines, a number in the subject. */
function preset(kind: 'form' | 'subject'): void {
  if (kind === 'form') {
    Object.assign(form, {
      name: form.name || t('identification.presets.formName'),
      conditions: conditionsDraft({ all: [{ field: 'from.email', op: 'eq', value: '' }] }),
      customerFrom: 'reply_to',
      extract: [
        { identityType: NAME_IDENTITY, source: 'body', header: '', pattern: t('identification.presets.namePattern'), trust: 'claimed' },
        { identityType: 'phone', source: 'body', header: '', pattern: t('identification.presets.phonePattern'), trust: 'claimed' },
      ],
    });
  } else {
    Object.assign(form, {
      name: form.name || t('identification.presets.subjectName'),
      conditions: conditionsDraft({ all: [{ field: 'subject', op: 'matches', value: '\\[[A-Z]+-\\d+\\]' }] }),
      customerFrom: 'sender',
      extract: [{ identityType: 'employee_id', source: 'subject', header: '', pattern: '\\[(?<value>[A-Z]+-\\d+)\\]', trust: 'claimed' }],
    });
  }
}

async function save(): Promise<void> {
  let conditions;
  try {
    conditions = conditionsFromDraft(form.conditions);
  } catch {
    toast.add({ color: 'error', title: t('rules.invalidJson') });
    return;
  }
  const body = {
    name: form.name,
    conditions,
    customerFrom: form.customerFrom,
    extract: form.extract.map(fromRow),
    stop: form.stop,
    enabled: form.enabled,
    position: form.position,
  };
  try {
    if (form.id) await api(`${base.value}/rules/${form.id}`, { method: 'PATCH', body });
    else await api(`${base.value}/rules`, { method: 'POST', body });
    open.value = false;
    await refresh();
  } catch (e) {
    const details = e instanceof ApiError && Array.isArray(e.details) ? (e.details as Array<{ path: string; message: string }>).map((d) => `${d.path}: ${d.message}`).join('; ') : '';
    toast.add({ color: 'error', title: e instanceof ApiError ? e.message : t('ticket.saveFailed'), description: details || undefined });
  }
}

async function toggle(rule: IdentificationRuleDto): Promise<void> {
  await api(`${base.value}/rules/${rule.id}`, { method: 'PATCH', body: { enabled: !rule.enabled } });
  await refresh();
}
async function remove(): Promise<void> {
  if (!form.id) return;
  await api(`${base.value}/rules/${form.id}`, { method: 'DELETE' });
  open.value = false;
  await refresh();
}

function typeName(type: string): string {
  return type === NAME_IDENTITY ? t('identification.nameType') : identityLabel(type, integrations.value.flatMap((i) => i.manifest?.identityTypes ?? []));
}
function describe(rule: IdentificationRuleDto): string {
  const extract = rule.extract.map((e) => `${typeName(e.identityType)}${e.identityType === NAME_IDENTITY ? '' : ` (${t(`identification.trust.${e.trust}`)})`}`).join(', ');
  return [describeCondition(rule.conditions), t(`identification.customerFrom.${rule.customerFrom}.short`), extract].filter(Boolean).join(' → ');
}

/* Check on a ticket */
const testNumber = ref('');
const testResult = ref<IdentificationCheckDto | null>(null);
async function runTest(): Promise<void> {
  const list = await api<TicketListDto>(`/workspaces/${workspaceId.value}/tickets?q=${encodeURIComponent(`#T-${testNumber.value.replace(/\D/g, '')}`)}&pageSize=1`);
  const ticket = list.items[0];
  if (!ticket) {
    toast.add({ color: 'warning', title: t('ticket.notFound') });
    return;
  }
  try {
    testResult.value = await api<IdentificationCheckDto>(`${base.value}/check`, { method: 'POST', body: { ticketId: ticket.id } });
  } catch (e) {
    toast.add({ color: 'error', title: e instanceof ApiError ? e.message : t('common.actionFailed') });
  }
}
const SOURCES = ['sender', 'api', 'rule', 'manifest', 'agent', 'operator'] as const;
function sourceLabel(source: string, ruleName: string | null, integrationName: string | null): string {
  const known = SOURCES.find((s) => s === source);
  const label = known ? t(`identification.source.${known}`) : source;
  return ruleName ? `${label} «${ruleName}»` : integrationName ? `${label} «${integrationName}»` : label;
}

/* From integrations */
async function setTextIdentities(integration: IntegrationDto, value: boolean): Promise<void> {
  await api(`/workspaces/${workspaceId.value}/integrations/${integration.id}`, { method: 'PATCH', body: { textIdentities: value } });
  await refreshIntegrations();
}
</script>

<template>
  <UDashboardPanel id="identification">
    <template #header>
      <UDashboardNavbar :title="t('identification.title')" />
    </template>
    <template #body>
      <div class="max-w-5xl space-y-6">
        <p class="text-sm text-(--ui-text-muted)">{{ t('identification.intro') }}</p>

        <UCard>
          <template #header>
            <p class="font-medium">{{ t('identification.sender.title') }}</p>
            <p class="text-xs text-(--ui-text-muted)">{{ t('identification.sender.description') }}</p>
          </template>
          <URadioGroup
            v-if="settings"
            :model-value="settings.trustSender"
            :items="TRUST_SENDER_ITEMS"
            :disabled="!isAdmin"
            @update:model-value="saveTrustSender($event as TrustSender)"
          />
        </UCard>

        <section class="space-y-2">
          <div class="flex items-center justify-between">
            <div>
              <h2 class="font-medium">{{ t('identification.rules.title') }}</h2>
              <p class="text-xs text-(--ui-text-muted)">{{ t('identification.rules.description') }}</p>
            </div>
            <UButton v-if="isAdmin" size="xs" icon="i-lucide-plus" variant="soft" @click="edit(null)">{{ t('rules.rule') }}</UButton>
          </div>
          <div v-for="rule in rules" :key="rule.id" class="flex items-center gap-3 rounded-md border border-(--ui-border) px-3 py-2" :class="rule.enabled ? '' : 'opacity-60'">
            <USwitch :model-value="rule.enabled" size="sm" :disabled="!isAdmin" @update:model-value="toggle(rule)" />
            <button class="min-w-0 flex-1 text-left" :disabled="!isAdmin" @click="edit(rule)">
              <p class="text-sm font-medium">{{ rule.name }} <UBadge v-if="rule.stop" color="neutral" variant="outline" size="sm">stop</UBadge></p>
              <p class="truncate font-mono text-xs text-(--ui-text-muted)">{{ describe(rule) }}</p>
            </button>
          </div>
          <p v-if="rules.length === 0" class="text-xs text-(--ui-text-muted)">{{ t('identification.rules.empty') }}</p>
        </section>

        <UCard>
          <template #header><p class="font-medium">{{ t('rules.checkOnTicket') }}</p></template>
          <div class="flex gap-2">
            <UInput v-model="testNumber" placeholder="T-12" class="w-40" @keydown.enter="runTest" />
            <UButton variant="soft" :disabled="!testNumber" @click="runTest">{{ t('rules.check') }}</UButton>
          </div>
          <div v-if="testResult" class="mt-3 space-y-2 text-sm">
            <p v-if="testResult.matched.length === 0" class="text-(--ui-text-muted)">{{ t('identification.check.noRules') }}</p>
            <p v-for="match in testResult.matched" :key="match.ruleId">✓ {{ match.name }}</p>
            <p>
              <span class="text-(--ui-text-muted)">{{ t('identification.check.customer') }}</span>
              {{ testResult.customer.name ?? '—' }} · {{ testResult.customer.email ?? '—' }}
              <span class="text-(--ui-text-muted)">({{ t(`identification.customerFrom.${testResult.customerFrom}.short`) }})</span>
            </p>
            <ul class="space-y-1">
              <li v-for="identity in testResult.identities" :key="`${identity.type}:${identity.value}`" class="flex flex-wrap items-center gap-2">
                <span>{{ typeName(identity.type) }}: <b>{{ identity.value }}</b></span>
                <UBadge :color="identity.trust === 'trusted' ? 'success' : 'warning'" variant="subtle" size="sm">{{ t(`identification.trust.${identity.trust}`) }}</UBadge>
                <span class="text-xs text-(--ui-text-muted)">{{ sourceLabel(identity.source, identity.ruleName, identity.integrationName) }}</span>
              </li>
            </ul>
            <details>
              <summary class="cursor-pointer text-xs text-(--ui-text-muted)">{{ t('rules.checkedData') }}</summary>
              <pre class="mt-1 overflow-auto rounded bg-(--ui-bg-muted) p-2 text-xs">{{ JSON.stringify(testResult.context, null, 2) }}</pre>
            </details>
          </div>
        </UCard>

        <section class="space-y-2">
          <div>
            <h2 class="font-medium">{{ t('identification.fromIntegrations.title') }}</h2>
            <p class="text-xs text-(--ui-text-muted)">{{ t('identification.fromIntegrations.description') }}</p>
          </div>
          <p v-if="!integrations.some((i) => i.manifest)" class="text-xs text-(--ui-text-muted)">{{ t('identification.fromIntegrations.empty') }}</p>
          <UCard v-for="integration in integrations.filter((i) => i.manifest)" :key="integration.id">
            <template #header>
              <div class="flex flex-wrap items-center gap-3">
                <div class="min-w-0 flex-1">
                  <p class="font-medium">{{ integration.name }}</p>
                  <p class="text-xs text-(--ui-text-muted)">
                    {{ t('identification.fromIntegrations.policy', { policy: t(`integrations.claimLinking.${integration.claimLinking}.label`) }) }}
                    · <NuxtLink :to="`/w/${workspaceId}/settings/integrations`" class="underline">{{ t('identification.fromIntegrations.change') }}</NuxtLink>
                  </p>
                </div>
                <USwitch
                  :model-value="integration.textIdentities"
                  :label="t('identification.fromIntegrations.textIdentities')"
                  :disabled="!isAdmin"
                  @update:model-value="(v: boolean) => setTextIdentities(integration, v)"
                />
              </div>
            </template>
            <ul class="divide-y divide-(--ui-border) text-sm">
              <li v-for="identity in integration.manifest!.identityTypes" :key="identity.type" class="py-1.5">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-medium">{{ identityLabel(identity.type, integration.manifest!.identityTypes) }}</span>
                  <code class="text-xs text-(--ui-text-muted)">{{ identity.type }}</code>
                  <UBadge v-if="identity.pattern" color="info" variant="subtle" size="sm">{{ t('identification.fromIntegrations.searchedInText') }}</UBadge>
                </div>
                <p v-if="identity.description" class="text-xs text-(--ui-text-muted)">{{ identity.description }}</p>
                <p v-if="identity.pattern" class="font-mono text-xs text-(--ui-text-dimmed)">{{ identity.pattern }}</p>
              </li>
            </ul>
          </UCard>
        </section>
      </div>

      <UModal v-model:open="open" :title="form.id ? t('rules.rule') : t('rules.new')" :ui="{ content: 'max-w-3xl' }">
        <template #body>
          <form id="identification-rule-form" class="space-y-4" @submit.prevent="save">
            <div class="flex flex-wrap items-end gap-2">
              <UFormField :label="t('common.name')" required class="min-w-64 flex-1"><UInput v-model="form.name" class="w-full" /></UFormField>
              <UButton size="sm" color="neutral" variant="soft" icon="i-lucide-file-input" @click="preset('form')">{{ t('identification.presets.form') }}</UButton>
              <UButton size="sm" color="neutral" variant="soft" icon="i-lucide-hash" @click="preset('subject')">{{ t('identification.presets.subject') }}</UButton>
            </div>

            <RulesConditionsEditor v-model="form.conditions" :field-paths="fieldPaths" />

            <UFormField :label="t('identification.customerFromLabel')">
              <URadioGroup v-model="form.customerFrom" :items="CUSTOMER_FROM_ITEMS" />
            </UFormField>

            <div class="space-y-2">
              <div>
                <p class="text-sm font-medium">{{ t('identification.extract.title') }}</p>
                <p class="text-xs text-(--ui-text-muted)">{{ t('identification.extract.description') }}</p>
              </div>
              <div v-for="(row, index) in form.extract" :key="index" class="flex flex-wrap items-center gap-2">
                <UInputMenu v-model="row.identityType" :items="identityTypes" value-key="value" create-item size="sm" class="w-48" @create="(v: string) => (row.identityType = v)" />
                <USelect v-model="row.source" :items="SOURCE_ITEMS" size="sm" class="w-32" />
                <UInput v-if="row.source === 'header'" v-model="row.header" placeholder="X-Guest-Id" size="sm" class="w-32 font-mono" />
                <UInput v-model="row.pattern" :placeholder="t('identification.presets.phonePattern')" size="sm" class="min-w-48 flex-1 font-mono" />
                <USelect v-if="row.identityType !== NAME_IDENTITY" v-model="row.trust" :items="TRUST_ITEMS" size="sm" class="w-36" />
                <UButton icon="i-lucide-x" size="sm" color="neutral" variant="ghost" @click="form.extract.splice(index, 1)" />
              </div>
              <UButton size="xs" variant="soft" icon="i-lucide-plus" @click="form.extract.push(emptyRow())">{{ t('identification.extract.add') }}</UButton>
            </div>

            <div class="flex items-center gap-6">
              <UFormField :label="t('rules.position')" class="w-28"><UInputNumber v-model="form.position" size="sm" /></UFormField>
              <UCheckbox v-model="form.stop" :label="t('identification.stop')" />
              <UCheckbox v-model="form.enabled" :label="t('rules.enabled')" />
            </div>
          </form>
        </template>
        <template #footer>
          <UButton v-if="form.id" color="error" variant="ghost" icon="i-lucide-trash-2" class="mr-auto" @click="remove">{{ t('common.delete') }}</UButton>
          <UButton color="neutral" variant="ghost" @click="open = false">{{ t('common.cancel') }}</UButton>
          <UButton type="submit" form="identification-rule-form">{{ t('common.save') }}</UButton>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
