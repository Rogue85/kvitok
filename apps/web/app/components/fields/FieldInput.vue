<script setup lang="ts">
import type { FieldDefinitionDto } from '@kvitok/shared';

const props = defineProps<{ field: FieldDefinitionDto; disabled?: boolean }>();
const model = defineModel<unknown>();

/** Archived options are not offered; the current value keeps its own, marked. */
const options = computed(() => {
  const current = new Set(Array.isArray(model.value) ? model.value : [model.value]);
  return props.field.options
    .filter((o) => !o.archived || current.has(o.value))
    .map((o) => ({ label: o.archived ? t('fieldsSettings.archivedOption', { label: o.label }) : o.label, value: o.value, group: o.group, description: o.agentHint }));
});
/** Long lists, lists with groups or from a directory get a searchable menu; short ones stay a plain select. */
const searchable = computed(() => options.value.length > 10 || options.value.some((o) => o.group) || props.field.optionSet !== null);
/** Grouped items: a label row per group, in the order the groups first appear. */
const menuItems = computed(() => {
  if (!options.value.some((o) => o.group)) return options.value;
  const groups = new Map<string, typeof options.value>();
  for (const option of options.value) {
    const key = option.group ?? '';
    groups.set(key, [...(groups.get(key) ?? []), option]);
  }
  // A label row carries a value too, so every item has the same keys for value-key; label rows are not selectable.
  return [...groups.entries()].map(([group, items]) => (group ? [{ type: 'label' as const, label: group, value: `group:${group}` }, ...items] : items));
});
const filterFields = ['label', 'group', 'description', 'value'];

const text = computed({
  get: () => (model.value === undefined || model.value === null ? '' : String(model.value)),
  set: (value: string) => {
    model.value = value === '' ? null : value;
  },
});

const numberValue = computed({
  get: () => (typeof model.value === 'number' ? model.value : null),
  set: (value: number | null | undefined) => {
    model.value = value ?? null;
  },
});

/** datetime-local ↔ ISO with a time zone. */
const localDateTime = computed({
  get: () => {
    if (typeof model.value !== 'string' || model.value === '') return '';
    const date = new Date(model.value);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  },
  set: (value: string) => {
    model.value = value === '' ? null : new Date(value).toISOString();
  },
});

const multi = computed({
  get: () => (Array.isArray(model.value) ? (model.value as string[]) : []),
  set: (value: string[]) => {
    model.value = value.length === 0 ? null : value;
  },
});

const inputType = computed(() => ({ email: 'email', phone: 'tel', url: 'url', date: 'date' })[props.field.type as string] ?? 'text');
</script>

<template>
  <UTextarea v-if="field.type === 'textarea'" v-model="text" :disabled="disabled" autoresize :rows="2" class="w-full" />
  <UInputNumber v-else-if="field.type === 'number'" v-model="numberValue" :disabled="disabled" class="w-full" />
  <USwitch v-else-if="field.type === 'boolean'" :model-value="model === true" :disabled="disabled" @update:model-value="model = $event" />
  <UInput v-else-if="field.type === 'datetime'" v-model="localDateTime" type="datetime-local" :disabled="disabled" class="w-full" />
  <div v-else-if="field.type === 'select'" class="flex w-full min-w-0 gap-1">
    <USelectMenu
      v-if="searchable"
      v-model="text"
      :items="menuItems"
      value-key="value"
      :filter-fields="filterFields"
      :search-input="{ placeholder: t('common.search') }"
      :disabled="disabled"
      placeholder="—"
      class="min-w-0 flex-1"
    />
    <USelect v-else v-model="text" :items="options" :disabled="disabled" placeholder="—" class="flex-1" />
    <UButton v-if="text && !disabled" icon="i-lucide-x" color="neutral" variant="ghost" size="sm" :aria-label="t('common.clear')" @click="text = ''" />
  </div>
  <USelectMenu
    v-else-if="field.type === 'multiselect'"
    v-model="multi"
    :items="menuItems"
    value-key="value"
    :filter-fields="filterFields"
    multiple
    :disabled="disabled"
    placeholder="—"
    class="w-full"
  />
  <UInput v-else v-model="text" :type="inputType" :disabled="disabled" class="w-full" />
</template>
