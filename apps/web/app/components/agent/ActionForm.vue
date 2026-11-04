<script setup lang="ts">
import { actionFormFields, type ActionCatalogIntegration, type ActionFormField, type ActionProposalDto, type ActionValidationIssue } from '@kvitok/shared';
import type { ActionFormPrefill } from '~/composables/useActionForm';

/**
 * An operator proposes an action by hand. The form is built from the action's input_schema (a JSON editor when the
 * schema does not fit a flat form); "Propose" asks the backend to validate, and the card then waits for "Execute".
 */
const props = defineProps<{ ticketId: string; prefill: ActionFormPrefill | null }>();
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ created: [action: ActionProposalDto] }>();

const toast = useToast();
const { workspaceId } = useWorkspace();
const base = computed(() => `/workspaces/${workspaceId.value}/tickets/${props.ticketId}/actions`);

const catalog = ref<ActionCatalogIntegration[]>([]);
const loading = ref(false);
const integration = computed(() => catalog.value.find((i) => i.integrationId === props.prefill?.integrationId) ?? null);
const action = computed(() => integration.value?.actions.find((a) => a.name === props.prefill?.action) ?? null);
const fields = computed<ActionFormField[] | null>(() => (action.value ? actionFormFields(action.value.inputSchema) : null));

/** Field values as typed: strings for inputs, booleans for switches; empty means "not set". */
const values = ref<Record<string, string | boolean | null>>({});
const json = ref('');
const reason = ref('');
const refreshDraft = ref(true);
const errors = ref<Record<string, string>>({});
const generalErrors = ref<string[]>([]);
const busy = ref(false);

watch(open, async (isOpen) => {
  if (!isOpen || !props.prefill) return;
  errors.value = {};
  generalErrors.value = [];
  reason.value = props.prefill.reason ?? '';
  refreshDraft.value = props.prefill.refreshDraft ?? true;
  loading.value = true;
  try {
    catalog.value = await api<ActionCatalogIntegration[]>(`${base.value}/catalog`);
  } catch (error) {
    toast.add({ color: 'error', title: error instanceof ApiError ? error.message : t('common.actionFailed') });
    open.value = false;
    return;
  } finally {
    loading.value = false;
  }
  fill(props.prefill.params ?? {});
});

function fill(params: Record<string, unknown>): void {
  const next: Record<string, string | boolean | null> = {};
  for (const field of fields.value ?? []) {
    const value = field.name in params ? params[field.name] : field.default;
    if (field.kind === 'boolean') next[field.name] = typeof value === 'boolean' ? value : null;
    else next[field.name] = value === null || value === undefined ? '' : String(value);
  }
  values.value = next;
  json.value = JSON.stringify(params, null, 2);
}

function fillExample(): void {
  const example = action.value?.examples[0];
  if (example) fill(example.params);
}

/** "Not set" in a select of an optional enum: a select item cannot have an empty value (Reka UI throws on it). */
const NOT_SET = '__kvitok_not_set__';
const selectItems = (field: Extract<ActionFormField, { kind: 'enum' }>) => [
  ...(field.required ? [] : [{ label: t('actionForm.notSet'), value: NOT_SET }]),
  ...field.options.map((o) => ({ label: String(o), value: String(o) })),
];

/** The parameters for the backend, or null with errors shown next to the fields. */
function collect(): Record<string, unknown> | null {
  const found: Record<string, string> = {};
  if (!fields.value) {
    try {
      const parsed: unknown = JSON.parse(json.value || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      return parsed as Record<string, unknown>;
    } catch {
      errors.value = { json: t('actionForm.invalidJson') };
      return null;
    }
  }
  const params: Record<string, unknown> = {};
  for (const field of fields.value) {
    const raw = values.value[field.name];
    if (field.kind === 'boolean') {
      if (raw !== null && raw !== undefined) params[field.name] = raw;
      else if (field.required) found[field.name] = t('actionForm.required');
      continue;
    }
    const text = typeof raw === 'string' && raw !== NOT_SET ? raw.trim() : '';
    if (text === '') {
      if (field.nullable) params[field.name] = null;
      else if (field.required) found[field.name] = t('actionForm.required');
      continue;
    }
    if (field.kind === 'integer' || field.kind === 'number') {
      const number = Number(text.replace(',', '.'));
      if (!Number.isFinite(number) || (field.kind === 'integer' && !Number.isInteger(number))) {
        found[field.name] = t(field.kind === 'integer' ? 'actionForm.notInteger' : 'actionForm.notNumber');
        continue;
      }
      params[field.name] = number;
    } else if (field.kind === 'enum') {
      params[field.name] = field.options.find((o) => String(o) === text) ?? text;
    } else {
      params[field.name] = text;
    }
  }
  errors.value = found;
  return Object.keys(found).length === 0 ? params : null;
}

async function submit(): Promise<void> {
  if (!props.prefill || !action.value) return;
  generalErrors.value = [];
  const params = collect();
  if (!reason.value.trim()) errors.value = { ...errors.value, reason: t('actionForm.reasonRequired') };
  if (!params || errors.value.reason) return;
  busy.value = true;
  try {
    const created = await api<ActionProposalDto>(base.value, {
      method: 'POST',
      body: {
        integrationId: props.prefill.integrationId,
        action: action.value.name,
        params,
        reason: reason.value.trim(),
        refreshDraft: refreshDraft.value,
        ...(props.prefill.replaces ? { replaces: props.prefill.replaces } : {}),
      },
    });
    toast.add({ icon: 'i-lucide-check', title: t('actionForm.proposed') });
    open.value = false;
    emit('created', created);
  } catch (error) {
    if (error instanceof ApiError && error.status === 422) showBackendErrors(error);
    else toast.add({ color: 'error', title: error instanceof ApiError ? error.message : t('common.actionFailed') });
  } finally {
    busy.value = false;
  }
}

/** The backend's validate errors go next to their fields; the rest above the buttons. */
function showBackendErrors(error: ApiError): void {
  const details = error.details as { errors?: ActionValidationIssue[] } | undefined;
  const issues = details?.errors ?? [];
  const byField: Record<string, string> = {};
  const general: string[] = [];
  for (const issue of issues) {
    const name = issue.path?.split(/[.[]/)[0];
    if (name && fields.value?.some((f) => f.name === name)) byField[name] = issue.message;
    else general.push(issue.message);
  }
  errors.value = byField;
  generalErrors.value = general.length > 0 || Object.keys(byField).length > 0 ? general : [error.message];
}
</script>

<template>
  <UModal v-model:open="open" :title="action?.title ?? t('actionForm.title')" :description="integration?.title" :ui="{ content: 'sm:max-w-lg' }">
    <template #body>
      <div v-if="loading" class="flex justify-center py-6"><UIcon name="i-lucide-loader" class="size-5 animate-spin text-(--ui-text-muted)" /></div>
      <UAlert v-else-if="!action" color="warning" variant="subtle" :title="t('actionForm.unavailable')" />
      <form v-else class="space-y-4" @submit.prevent="submit">
        <p class="text-xs whitespace-pre-line text-(--ui-text-muted)">{{ action.description }}</p>

        <template v-if="fields">
          <div class="grid gap-3 sm:grid-cols-2">
            <UFormField
              v-for="field in fields"
              :key="field.name"
              :label="field.label"
              :required="field.required"
              :hint="field.nullable ? t('actionForm.canBeEmpty') : undefined"
              :description="field.description ?? undefined"
              :error="errors[field.name]"
              :class="{ 'sm:col-span-2': field.kind === 'string' && (field.maxLength ?? 1000) > 100 }"
            >
              <USelect
                v-if="field.kind === 'enum'"
                v-model="values[field.name] as string"
                :items="selectItems(field)"
                :placeholder="field.required ? undefined : t('actionForm.notSet')"
                class="w-full"
              />
              <USwitch v-else-if="field.kind === 'boolean'" :model-value="values[field.name] === true" @update:model-value="values[field.name] = $event" />
              <UInput
                v-else
                v-model="values[field.name] as string"
                :inputmode="field.kind === 'string' ? undefined : 'decimal'"
                :placeholder="field.kind === 'integer' && field.min !== null ? String(field.min) : undefined"
                class="w-full"
              />
            </UFormField>
          </div>
        </template>
        <UFormField v-else :label="t('actionForm.parameters')" :description="t('actionForm.jsonHint')" :error="errors.json">
          <UTextarea v-model="json" :rows="6" autoresize class="w-full font-mono text-xs" />
        </UFormField>
        <UButton v-if="action.examples.length" size="xs" color="neutral" variant="link" icon="i-lucide-wand-sparkles" class="px-0" @click="fillExample">
          {{ t('actionForm.fillExample') }}
        </UButton>

        <UFormField :label="t('actionForm.reason')" :description="t('actionForm.reasonHint')" required :error="errors.reason">
          <UInput v-model="reason" :placeholder="t('actionForm.reasonPlaceholder')" class="w-full" @update:model-value="errors.reason = ''" />
        </UFormField>
        <USwitch v-model="refreshDraft" :label="t('actionForm.refreshDraft')" />

        <UAlert v-for="message in generalErrors" :key="message" color="error" variant="subtle" icon="i-lucide-circle-x" :title="message" />
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="open = false">{{ t('common.cancel') }}</UButton>
        <UButton icon="i-lucide-shield-check" :loading="busy" :disabled="!action" @click="submit">{{ t('actionForm.propose') }}</UButton>
      </div>
    </template>
  </UModal>
</template>
