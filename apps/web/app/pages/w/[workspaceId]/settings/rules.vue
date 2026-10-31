<script setup lang="ts">
import {
  RULE_OPERATORS,
  TICKET_PRIORITIES,
  type RoutingRuleDto,
  type RuleCondition,
  type RuleEffect,
  type RuleLeaf,
  type RuleOperator,
  type RuleStage,
  type RuleTestResultDto,
  type TicketListDto,
  type TicketPriority,
} from '@kvitok/shared';

const toast = useToast();
const { workspaceId, can } = useWorkspace();
const { departments, members, ticketFields, customerFields } = useWorkspaceData();
const isAdmin = computed(() => can('admin'));
const base = computed(() => `/workspaces/${workspaceId.value}/routing-rules`);

const { data: rules, refresh } = await useAsyncData(() => `rules:${workspaceId.value}`, () => api<RoutingRuleDto[]>(base.value), { default: () => [] });

const STAGES: Array<{ value: RuleStage; title: string; description: string }> = (['on_ingest', 'after_agent'] as const).map((value) => ({
  value,
  title: t(`rules.stage.${value}.title`),
  description: t(`rules.stage.${value}.description`),
}));
const OP_LABELS = Object.fromEntries(RULE_OPERATORS.map((op) => [op, t(`rules.op.${op}`)])) as Record<RuleOperator, string>;
const EFFECT_TYPES: Array<RuleEffect['type']> = ['set_department', 'set_priority', 'add_tags', 'assign', 'set_field', 'set_field_from_regex', 'skip_agent'];
const EFFECT_LABELS = Object.fromEntries(EFFECT_TYPES.map((type) => [type, t(`rules.effect.${type}`)])) as Record<RuleEffect['type'], string>;
const fieldPaths = computed(() => [
  'subject', 'body', 'channel.type', 'from.email', 'from.domain', 'metadata.',
  ...ticketFields.value.map((f) => `fields.${f.key}`),
  ...customerFields.value.map((f) => `customer.fields.${f.key}`),
  'customer.identity.email', 'customer.identity.phone',
  'ticket.priority', 'ticket.department', 'ticket.tags', 'time.hour', 'time.weekday',
  'agent.department', 'agent.confidence', 'agent.needs_human',
]);

interface LeafRow { field: string; op: RuleOperator; value: string }
interface EffectRow { type: RuleEffect['type']; departmentKey: string; priority: TicketPriority; tags: string[]; userId: string; key: string; value: string; source: 'subject' | 'body'; pattern: string }

const emptyEffect = (): EffectRow => ({ type: 'set_department', departmentKey: '', priority: 'high', tags: [], userId: '', key: '', value: '', source: 'subject', pattern: '' });
const open = ref(false);
const advanced = ref(false);
const form = reactive({
  id: null as string | null,
  name: '',
  stage: 'on_ingest' as RuleStage,
  match: 'all' as 'all' | 'any',
  leaves: [] as LeafRow[],
  conditionsJson: '',
  effects: [] as EffectRow[],
  stop: false,
  enabled: true,
  position: 0,
});

function leafToRow(leaf: RuleLeaf): LeafRow {
  const value = Array.isArray(leaf.value) ? leaf.value.join(', ') : leaf.value === undefined ? '' : String(leaf.value);
  return { field: leaf.field, op: leaf.op, value };
}
function rowToLeaf(row: LeafRow): RuleLeaf {
  if (row.op === 'is_empty' || row.op === 'is_not_empty') return { field: row.field, op: row.op };
  if (row.op === 'in' || row.op === 'not_in' || row.op === 'between') {
    return { field: row.field, op: row.op, value: row.value.split(/[,;]|\s-\s/).map((v) => v.trim()).filter(Boolean) };
  }
  return { field: row.field, op: row.op, value: row.value };
}
function isFlat(condition: RuleCondition): condition is { all: RuleLeaf[] } | { any: RuleLeaf[] } {
  const list = 'all' in condition ? condition.all : 'any' in condition ? condition.any : null;
  return list !== null && list.every((c) => 'field' in c);
}

function edit(rule: RoutingRuleDto | null, stage: RuleStage = 'on_ingest'): void {
  const conditions: RuleCondition = rule?.conditions ?? { all: [{ field: 'subject', op: 'contains', value: '' }] };
  const flat = 'field' in conditions ? { all: [conditions] } : conditions;
  advanced.value = !isFlat(flat);
  Object.assign(form, {
    id: rule?.id ?? null,
    name: rule?.name ?? '',
    stage: rule?.stage ?? stage,
    match: 'any' in flat ? 'any' : 'all',
    leaves: isFlat(flat) ? ('all' in flat ? flat.all : flat.any).map(leafToRow) : [],
    conditionsJson: JSON.stringify(conditions, null, 2),
    effects: (rule?.effects ?? [{ type: 'set_department', departmentKey: '' } as RuleEffect]).map((e) => ({ ...emptyEffect(), ...e, value: 'value' in e ? String(e.value ?? '') : '' })),
    stop: rule?.stop ?? false,
    enabled: rule?.enabled ?? true,
    position: rule?.position ?? (rules.value.filter((r) => r.stage === stage).length + 1) * 10,
  });
  open.value = true;
}

function effectFromRow(row: EffectRow): RuleEffect {
  switch (row.type) {
    case 'set_department': return { type: row.type, departmentKey: row.departmentKey };
    case 'set_priority': return { type: row.type, priority: row.priority } as RuleEffect;
    case 'add_tags': return { type: row.type, tags: row.tags };
    case 'assign': return { type: row.type, userId: row.userId };
    case 'set_field': return { type: row.type, key: row.key, value: row.value };
    case 'set_field_from_regex': return { type: row.type, key: row.key, source: row.source, pattern: row.pattern };
    case 'skip_agent': return { type: row.type };
  }
}

async function save(): Promise<void> {
  let conditions: RuleCondition;
  try {
    conditions = advanced.value ? JSON.parse(form.conditionsJson) : { [form.match]: form.leaves.map(rowToLeaf) } as RuleCondition;
  } catch {
    toast.add({ color: 'error', title: t('rules.invalidJson') });
    return;
  }
  const effects = form.effects.map(effectFromRow);
  const body = { name: form.name, conditions, effects, stop: form.stop, enabled: form.enabled, position: form.position };
  try {
    if (form.id) await api(`${base.value}/${form.id}`, { method: 'PATCH', body });
    else await api(base.value, { method: 'POST', body: { ...body, stage: form.stage } });
    open.value = false;
    await refresh();
  } catch (e) {
    const details = e instanceof ApiError && Array.isArray(e.details) ? (e.details as Array<{ path: string; message: string }>).map((d) => `${d.path}: ${d.message}`).join('; ') : '';
    toast.add({ color: 'error', title: e instanceof ApiError ? e.message : t('ticket.saveFailed'), description: details || undefined });
  }
}

async function toggle(rule: RoutingRuleDto): Promise<void> {
  await api(`${base.value}/${rule.id}`, { method: 'PATCH', body: { enabled: !rule.enabled } });
  await refresh();
}
async function remove(): Promise<void> {
  if (!form.id) return;
  await api(`${base.value}/${form.id}`, { method: 'DELETE' });
  open.value = false;
  await refresh();
}

function describe(rule: RoutingRuleDto): string {
  const leaves = (c: RuleCondition): string =>
    'field' in c
      ? `${c.field} ${OP_LABELS[c.op]}${c.value !== undefined ? ` ${Array.isArray(c.value) ? c.value.join(', ') : String(c.value)}` : ''}`
      : 'all' in c ? c.all.map(leaves).join(` ${t('rules.and')} `) : 'any' in c ? `(${c.any.map(leaves).join(` ${t('rules.or')} `)})` : t('rules.not', { condition: leaves(c.not) });
  return `${leaves(rule.conditions)} → ${rule.effects.map((e) => EFFECT_LABELS[e.type]).join(', ')}`;
}

/* Check on a ticket */
const testNumber = ref('');
const testResult = ref<RuleTestResultDto[] | null>(null);
async function runTest(): Promise<void> {
  const list = await api<TicketListDto>(`/workspaces/${workspaceId.value}/tickets?q=${encodeURIComponent(`#T-${testNumber.value.replace(/\D/g, '')}`)}&pageSize=1`);
  const ticket = list.items[0];
  if (!ticket) {
    toast.add({ color: 'warning', title: t('ticket.notFound') });
    return;
  }
  testResult.value = await api<RuleTestResultDto[]>(`${base.value}/test`, { method: 'POST', body: { ticketId: ticket.id } });
}

const departmentItems = computed(() => departments.data.value.filter((d) => !d.archived).map((d) => ({ label: d.title, value: d.key })));
const memberItems = computed(() => members.data.value.filter((m) => m.role !== 'viewer').map((m) => ({ label: m.name, value: m.userId })));
const fieldItems = computed(() => ticketFields.value.map((f) => ({ label: f.label, value: f.key })));
</script>

<template>
  <UDashboardPanel id="rules">
    <template #header>
      <UDashboardNavbar :title="t('rules.title')" />
    </template>
    <template #body>
      <div class="max-w-5xl space-y-6">
        <p class="text-sm text-(--ui-text-muted)">
          {{ t('rules.intro') }}
        </p>

        <section v-for="stage in STAGES" :key="stage.value" class="space-y-2">
          <div class="flex items-center justify-between">
            <div>
              <h2 class="font-medium">{{ stage.title }}</h2>
              <p class="text-xs text-(--ui-text-muted)">{{ stage.description }}</p>
            </div>
            <UButton v-if="isAdmin" size="xs" icon="i-lucide-plus" variant="soft" @click="edit(null, stage.value)">{{ t('rules.rule') }}</UButton>
          </div>
          <div v-for="rule in rules.filter((r) => r.stage === stage.value)" :key="rule.id" class="flex items-center gap-3 rounded-md border border-(--ui-border) px-3 py-2" :class="rule.enabled ? '' : 'opacity-60'">
            <USwitch :model-value="rule.enabled" size="sm" :disabled="!isAdmin" @update:model-value="toggle(rule)" />
            <button class="min-w-0 flex-1 text-left" :disabled="!isAdmin" @click="edit(rule)">
              <p class="text-sm font-medium">{{ rule.name }} <UBadge v-if="rule.stop" color="neutral" variant="outline" size="sm">stop</UBadge></p>
              <p class="truncate font-mono text-xs text-(--ui-text-muted)">{{ describe(rule) }}</p>
            </button>
          </div>
          <p v-if="!rules.some((r) => r.stage === stage.value)" class="text-xs text-(--ui-text-muted)">{{ t('rules.empty') }}</p>
        </section>

        <UCard>
          <template #header><p class="font-medium">{{ t('rules.checkOnTicket') }}</p></template>
          <div class="flex gap-2">
            <UInput v-model="testNumber" placeholder="T-12" class="w-40" @keydown.enter="runTest" />
            <UButton variant="soft" :disabled="!testNumber" @click="runTest">{{ t('rules.check') }}</UButton>
          </div>
          <div v-if="testResult" class="mt-3 space-y-2 text-sm">
            <div v-for="item in testResult" :key="item.stage">
              <p class="font-medium">{{ STAGES.find((s) => s.value === item.stage)?.title }}:</p>
              <p v-if="item.matched.length === 0" class="text-(--ui-text-muted)">{{ t('rules.nothingMatched') }}</p>
              <p v-for="match in item.matched" :key="match.ruleId">✓ {{ match.name }} → {{ match.effects.map((e) => EFFECT_LABELS[e.type]).join(', ') }}</p>
            </div>
            <details>
              <summary class="cursor-pointer text-xs text-(--ui-text-muted)">{{ t('rules.checkedData') }}</summary>
              <pre class="mt-1 overflow-auto rounded bg-(--ui-bg-muted) p-2 text-xs">{{ JSON.stringify(testResult[0]?.context, null, 2) }}</pre>
            </details>
          </div>
        </UCard>
      </div>

      <UModal v-model:open="open" :title="form.id ? t('rules.rule') : t('rules.new')" :ui="{ content: 'max-w-3xl' }">
        <template #body>
          <form id="rule-form" class="space-y-4" @submit.prevent="save">
            <div class="grid grid-cols-3 gap-3">
              <UFormField :label="t('common.name')" required class="col-span-2"><UInput v-model="form.name" class="w-full" /></UFormField>
              <UFormField :label="t('rules.stageLabel')">
                <USelect v-model="form.stage" :items="STAGES.map((s) => ({ label: s.title, value: s.value }))" :disabled="Boolean(form.id)" class="w-full" />
              </UFormField>
            </div>

            <div class="space-y-2">
              <div class="flex items-center gap-2">
                <p class="text-sm font-medium">{{ t('rules.conditions') }}</p>
                <USelect
                  v-if="!advanced"
                  v-model="form.match"
                  :items="[
                    { label: t('rules.matchAll'), value: 'all' },
                    { label: t('rules.matchAny'), value: 'any' },
                  ]"
                  size="xs"
                  class="w-24"
                />
                <UButton size="xs" variant="link" class="ml-auto" @click="advanced = !advanced">{{ advanced ? t('rules.builder') : 'JSON' }}</UButton>
              </div>
              <UTextarea v-if="advanced" v-model="form.conditionsJson" autoresize :rows="6" class="w-full font-mono text-xs" />
              <template v-else>
                <div v-for="(leaf, index) in form.leaves" :key="index" class="grid grid-cols-[2fr_8rem_2fr_auto] gap-2">
                  <UInputMenu v-model="leaf.field" :items="fieldPaths" create-item size="sm" @create="(v: string) => (leaf.field = v)" />
                  <USelect v-model="leaf.op" :items="RULE_OPERATORS.map((op) => ({ label: OP_LABELS[op], value: op }))" size="sm" />
                  <UInput v-model="leaf.value" size="sm" :disabled="leaf.op === 'is_empty' || leaf.op === 'is_not_empty'" :placeholder="leaf.op === 'between' ? '200, 299' : leaf.op === 'in' ? 'a, b, c' : ''" />
                  <UButton icon="i-lucide-x" size="sm" color="neutral" variant="ghost" @click="form.leaves.splice(index, 1)" />
                </div>
                <UButton size="xs" variant="soft" icon="i-lucide-plus" @click="form.leaves.push({ field: 'subject', op: 'contains', value: '' })">{{ t('rules.condition') }}</UButton>
              </template>
            </div>

            <div class="space-y-2">
              <p class="text-sm font-medium">{{ t('rules.effects') }}</p>
              <div v-for="(effect, index) in form.effects" :key="index" class="flex flex-wrap items-center gap-2">
                <USelect
                  v-model="effect.type"
                  :items="Object.entries(EFFECT_LABELS).filter(([type]) => form.stage === 'on_ingest' || type !== 'skip_agent').map(([value, label]) => ({ label, value }))"
                  size="sm"
                  class="w-48"
                />
                <USelect v-if="effect.type === 'set_department'" v-model="effect.departmentKey" :items="departmentItems" size="sm" class="w-48" />
                <USelect v-if="effect.type === 'set_priority'" v-model="effect.priority" :items="TICKET_PRIORITIES.map((p) => ({ label: priorityLabel(p), value: p }))" size="sm" class="w-40" />
                <UInputTags v-if="effect.type === 'add_tags'" v-model="effect.tags" size="sm" class="w-64" />
                <USelect v-if="effect.type === 'assign'" v-model="effect.userId" :items="memberItems" size="sm" class="w-48" />
                <template v-if="effect.type === 'set_field' || effect.type === 'set_field_from_regex'">
                  <USelect v-model="effect.key" :items="fieldItems" size="sm" class="w-44" />
                  <UInput v-if="effect.type === 'set_field'" v-model="effect.value" :placeholder="t('fieldsSettings.optionValue')" size="sm" class="w-40" />
                  <template v-else>
                    <USelect
                      v-model="effect.source"
                      :items="[
                        { label: t('rules.fromSubject'), value: 'subject' },
                        { label: t('rules.fromBody'), value: 'body' },
                      ]"
                      size="sm"
                      class="w-32"
                    />
                    <UInput v-model="effect.pattern" placeholder="\[DEP-(\d{3})\]" size="sm" class="w-48 font-mono" />
                  </template>
                </template>
                <UButton icon="i-lucide-x" size="sm" color="neutral" variant="ghost" @click="form.effects.splice(index, 1)" />
              </div>
              <UButton size="xs" variant="soft" icon="i-lucide-plus" @click="form.effects.push(emptyEffect())">{{ t('rules.effect.add') }}</UButton>
            </div>

            <div class="flex items-center gap-6">
              <UFormField :label="t('rules.position')" class="w-28"><UInputNumber v-model="form.position" size="sm" /></UFormField>
              <UCheckbox v-model="form.stop" :label="t('rules.stop')" />
              <UCheckbox v-model="form.enabled" :label="t('rules.enabled')" />
            </div>
          </form>
        </template>
        <template #footer>
          <UButton v-if="form.id" color="error" variant="ghost" icon="i-lucide-trash-2" class="mr-auto" @click="remove">{{ t('common.delete') }}</UButton>
          <UButton color="neutral" variant="ghost" @click="open = false">{{ t('common.cancel') }}</UButton>
          <UButton type="submit" form="rule-form">{{ t('common.save') }}</UButton>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
