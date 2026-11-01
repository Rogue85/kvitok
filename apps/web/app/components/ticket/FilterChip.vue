<script setup lang="ts">
import type { CommandPaletteItem } from '@nuxt/ui';
import { DATE_PRESETS, type TicketFilterDef, type TicketFilterOption } from '~/utils/ticket-filters';

const props = defineProps<{ filter: TicketFilterDef }>();
const value = defineModel<string>({ required: true });
const open = defineModel<boolean>('open', { default: false });
defineEmits<{ remove: [] }>();

const values = computed(() => (value.value ? value.value.split(',') : []));
const options = computed(() => props.filter.options ?? []);
const selected = computed(() => options.value.filter((o) => values.value.includes(o.value)));

function pick(picked: CommandPaletteItem | CommandPaletteItem[]): void {
  if (Array.isArray(picked)) {
    value.value = (picked as TicketFilterOption[]).map((o) => o.value).join(',');
  } else {
    value.value = (picked as TicketFilterOption).value;
    open.value = false;
  }
}

const presetLabel = (preset: string) => t(`tickets.filters.datePresets.${preset as (typeof DATE_PRESETS)[number]}`);
const [fromDate, toDate, text] = [ref(''), ref(''), ref('')];
watch(open, (isOpen) => {
  if (!isOpen) return;
  const [from = '', to = ''] = (DATE_PRESETS as readonly string[]).includes(value.value) ? [] : value.value.split('..');
  fromDate.value = from;
  toDate.value = to;
  text.value = value.value;
});
function applyRange(): void {
  value.value = fromDate.value || toDate.value ? `${fromDate.value}..${toDate.value}` : '';
  open.value = false;
}

function applyText(): void {
  value.value = text.value.trim();
  open.value = false;
}

const summary = computed(() => {
  if (!value.value) return t('tickets.filters.any');
  switch (props.filter.kind) {
    case 'options':
    case 'option': {
      const labels = selected.value.map((o) => o.label);
      if (labels.length === 0) return values.value.join(', ');
      return labels.length <= 2 ? labels.join(', ') : `${labels[0]} +${labels.length - 1}`;
    }
    case 'date':
      if ((DATE_PRESETS as readonly string[]).includes(value.value)) return presetLabel(value.value);
      return value.value
        .split('..')
        .map((d) => (d ? formatDate(new Date(`${d}T00:00`).toISOString()) : '…'))
        .join(' – ');
    default:
      return value.value;
  }
});
</script>

<template>
  <UFieldGroup size="sm">
    <UButton v-if="filter.kind === 'flag'" color="neutral" variant="subtle" :icon="filter.icon" :label="filter.label" class="pointer-events-none" />
    <UPopover v-else v-model:open="open" :content="{ align: 'start' }">
      <UButton color="neutral" variant="subtle" :icon="filter.icon" class="max-w-72">
        <span class="text-(--ui-text-muted)">{{ filter.label }}:</span>
        <span class="truncate">{{ summary }}</span>
      </UButton>

      <template #content>
        <UCommandPalette
          v-if="filter.kind === 'options' || filter.kind === 'option'"
          :model-value="filter.kind === 'options' ? selected : selected[0]"
          :multiple="filter.kind === 'options'"
          by="value"
          :groups="[{ id: filter.key, items: options }]"
          :placeholder="t('common.search')"
          class="max-h-80 w-64"
          @update:model-value="pick"
        />
        <div v-else-if="filter.kind === 'date'" class="flex w-64 flex-col gap-1 p-2">
          <UButton
            v-for="preset in DATE_PRESETS"
            :key="preset"
            color="neutral"
            :variant="value === preset ? 'soft' : 'ghost'"
            :label="presetLabel(preset)"
            @click="value = preset; open = false"
          />
          <USeparator class="my-1" />
          <div class="grid grid-cols-2 gap-2">
            <UFormField :label="t('tickets.filters.from')" size="xs">
              <UInput v-model="fromDate" type="date" size="sm" />
            </UFormField>
            <UFormField :label="t('tickets.filters.to')" size="xs">
              <UInput v-model="toDate" type="date" size="sm" />
            </UFormField>
          </div>
          <UButton :label="t('tickets.filters.apply')" size="sm" block class="mt-1" @click="applyRange" />
        </div>
        <form v-else class="flex w-64 gap-2 p-2" @submit.prevent="applyText">
          <UInput v-model="text" size="sm" autofocus class="flex-1" />
          <UButton type="submit" :label="t('tickets.filters.apply')" size="sm" />
        </form>
      </template>
    </UPopover>
    <UButton color="neutral" variant="subtle" icon="i-lucide-x" :aria-label="t('tickets.filters.remove')" @click="$emit('remove')" />
  </UFieldGroup>
</template>
