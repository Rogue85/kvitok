<script setup lang="ts" generic="T extends object">
import type { TableColumn } from '@nuxt/ui';

/**
 * A UTable on desktop and a list of cards on phones, from the same columns and cell slots.
 * A card shows the first column as its title, the `actions` column next to it,
 * and every other column as a "header — value" line.
 */
defineOptions({ inheritAttrs: false });

const props = defineProps<{
  data: T[];
  columns: TableColumn<T>[];
  loading?: boolean;
  onSelect?: (event: Event, row: { original: T }) => void;
  ui?: Record<string, string>;
}>();
defineSlots<Record<string, (props: { row: { original: T; index: number } }) => unknown>>();

const mobile = useMobile();

type Column = { id: string; header: string };
const columnsById = computed<Column[]>(() =>
  props.columns.map((column) => ({
    id: column.id ?? String((column as { accessorKey?: string }).accessorKey ?? ''),
    header: typeof column.header === 'string' ? column.header : '',
  })),
);
const title = computed(() => columnsById.value.find((c) => c.id !== 'actions' && c.id !== 'select') ?? null);
const actions = computed(() => columnsById.value.some((c) => c.id === 'actions'));
const details = computed(() => columnsById.value.filter((c) => c.id !== 'actions' && c.id !== 'select' && c.id !== title.value?.id));

/** The cell without a slot: the value as the table would show it. */
function plain(item: T, id: string): string {
  const value = (item as Record<string, unknown>)[id];
  return value === null || value === undefined || value === '' ? t('common.none') : String(value);
}
</script>

<template>
  <template v-if="mobile">
    <ul v-if="data.length" class="divide-y divide-(--ui-border) rounded-lg border border-(--ui-border)" :class="loading ? 'opacity-60' : ''">
      <li
        v-for="(item, index) in data"
        :key="index"
        class="px-4 py-3"
        :class="onSelect ? 'cursor-pointer active:bg-(--ui-bg-elevated)' : ''"
        @click="onSelect?.($event, { original: item })"
      >
        <div class="flex items-start gap-2">
          <div v-if="title" class="min-w-0 flex-1 font-medium break-words">
            <slot :name="`${title.id}-cell`" :row="{ original: item, index }">{{ plain(item, title.id) }}</slot>
          </div>
          <div v-if="actions" class="-my-1 shrink-0" @click.stop>
            <slot name="actions-cell" :row="{ original: item, index }" />
          </div>
        </div>
        <dl v-if="details.length" class="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 text-sm">
          <template v-for="column in details" :key="column.id">
            <dt class="max-w-28 text-(--ui-text-muted)">{{ column.header }}</dt>
            <dd class="min-w-0 break-words">
              <slot :name="`${column.id}-cell`" :row="{ original: item, index }">{{ plain(item, column.id) }}</slot>
            </dd>
          </template>
        </dl>
      </li>
    </ul>
    <div v-else-if="!loading">
      <slot name="empty" :row="{ original: {} as T, index: -1 }">
        <p class="py-6 text-center text-sm text-(--ui-text-muted)">{{ t('common.noData') }}</p>
      </slot>
    </div>
  </template>

  <UTable v-else v-bind="$attrs" :data="data" :columns="columns" :loading="loading" :on-select="onSelect" :ui="ui">
    <template v-for="(_, name) in $slots" #[name]="slotProps">
      <slot :name="name" v-bind="slotProps" />
    </template>
  </UTable>
</template>
