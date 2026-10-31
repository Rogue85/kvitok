<script setup lang="ts">
import type { FieldDefinitionDto } from '@kvitok/shared';

const props = defineProps<{ field: FieldDefinitionDto; disabled?: boolean }>();
const model = defineModel<unknown>();

const options = computed(() => props.field.options.map((o) => ({ label: o.label, value: o.value })));

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
  <div v-else-if="field.type === 'select'" class="flex w-full gap-1">
    <USelect v-model="text" :items="options" :disabled="disabled" placeholder="—" class="flex-1" />
    <UButton v-if="text && !disabled" icon="i-lucide-x" color="neutral" variant="ghost" size="sm" :aria-label="t('common.clear')" @click="text = ''" />
  </div>
  <USelectMenu
    v-else-if="field.type === 'multiselect'"
    v-model="multi"
    :items="options"
    value-key="value"
    multiple
    :disabled="disabled"
    placeholder="—"
    class="w-full"
  />
  <UInput v-else v-model="text" :type="inputType" :disabled="disabled" class="w-full" />
</template>
