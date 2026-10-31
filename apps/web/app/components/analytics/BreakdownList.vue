<script setup lang="ts">
export interface BreakdownRow {
  key: string;
  label: string;
  /** What the bar length is proportional to. */
  value: number;
  display: string;
  meta?: string;
  to?: string;
}

const props = defineProps<{ rows: BreakdownRow[]; empty: string }>();
const max = computed(() => Math.max(0, ...props.rows.map((r) => r.value)));
</script>

<template>
  <ul v-if="rows.length" class="space-y-3">
    <li v-for="row in rows" :key="row.key">
      <div class="flex items-baseline gap-3 text-sm">
        <NuxtLink v-if="row.to" :to="row.to" class="min-w-0 flex-1 truncate hover:underline">{{ row.label }}</NuxtLink>
        <span v-else class="min-w-0 flex-1 truncate first-letter:uppercase">{{ row.label }}</span>
        <span v-if="row.meta" class="shrink-0 text-xs text-(--ui-text-muted)">{{ row.meta }}</span>
        <span class="shrink-0 font-medium tabular-nums">{{ row.display }}</span>
      </div>
      <div class="mt-1 h-1.5 rounded-full bg-(--ui-bg-elevated)">
        <div class="h-full rounded-full bg-(--ui-primary)" :style="{ width: max > 0 ? `${(row.value / max) * 100}%` : '0' }" />
      </div>
    </li>
  </ul>
  <p v-else class="text-sm text-(--ui-text-muted)">{{ empty }}</p>
</template>
