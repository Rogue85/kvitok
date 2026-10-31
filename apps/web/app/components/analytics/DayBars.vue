<script setup lang="ts">
import type { AnalyticsDayDto } from '@kvitok/shared';

const props = defineProps<{
  days: AnalyticsDayDto[];
  value: (day: AnalyticsDayDto) => number;
  format: (value: number) => string;
  /** Lines of the tooltip and of the table row after the date. */
  details: (day: AnalyticsDayDto) => string[];
  /** Show the numbers as a table instead of bars. */
  table?: boolean;
  /** Counts: the axis gets no fractional ticks. */
  integer?: boolean;
}>();

const values = computed(() => props.days.map(props.value));
const max = computed(() => niceMax(Math.max(0, ...values.value)));
const ticks = computed(() => {
  if (max.value <= 0) return [0];
  return props.integer && max.value % 2 !== 0 ? [max.value, 0] : [max.value, max.value / 2, 0];
});
/** The first, middle and last days are labelled: enough to read the dates, never crowded. */
const labelled = computed(() => {
  const n = props.days.length;
  return new Set([0, Math.floor((n - 1) / 2), n - 1]);
});

const hovered = ref<number | null>(null);
const tooltipStyle = computed(() => {
  if (hovered.value === null) return {};
  const at = (hovered.value + 0.5) / props.days.length;
  const shift = at < 0.15 ? '0' : at > 0.85 ? '-100%' : '-50%';
  return { left: `${at * 100}%`, transform: `translateX(${shift})` };
});

function height(value: number): string {
  if (value <= 0 || max.value <= 0) return '0';
  // A tiny value still shows up as a sliver.
  return `max(2px, ${(value / max.value) * 100}%)`;
}

/** A round axis maximum: 1, 2, 2.5 or 5 times a power of ten; for counts 4 instead of 2.5, so the middle tick is whole. */
function niceMax(value: number): number {
  if (value <= 0) return 0;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = (props.integer ? [1, 2, 4, 5, 10] : [1, 2, 2.5, 5, 10]).find((s) => s * power >= value)!;
  return step * power;
}
</script>

<template>
  <table v-if="table" class="w-full text-sm">
    <tbody>
      <tr v-for="(day, i) in days" :key="day.date" class="border-b border-(--ui-border) last:border-0">
        <td class="py-1 text-(--ui-text-muted)">{{ formatDay(day.date) }}</td>
        <td class="py-1 text-right font-medium tabular-nums">{{ format(values[i]!) }}</td>
        <td class="py-1 pl-4 text-right text-(--ui-text-muted)">{{ details(day).join(' · ') }}</td>
      </tr>
    </tbody>
  </table>

  <div v-else class="flex gap-2">
    <div class="flex h-48 flex-col justify-between text-right text-xs tabular-nums text-(--ui-text-muted)">
      <span v-for="tick in ticks" :key="tick" class="-my-2 leading-4">{{ format(tick) }}</span>
    </div>
    <div class="min-w-0 flex-1">
      <div class="relative h-48">
        <div class="absolute inset-0 flex flex-col justify-between">
          <div v-for="tick in ticks" :key="tick" class="border-t border-(--ui-border)" />
        </div>
        <div class="absolute inset-0 flex items-end gap-0.5" @mouseleave="hovered = null">
          <div
            v-for="(day, i) in days"
            :key="day.date"
            class="flex h-full min-w-0 flex-1 items-end justify-center outline-none"
            tabindex="0"
            :aria-label="[formatDay(day.date), format(values[i]!), ...details(day)].join(', ')"
            @mouseenter="hovered = i"
            @focus="hovered = i"
            @blur="hovered = null"
          >
            <div
              class="w-full max-w-6 rounded-t-[4px] bg-(--ui-primary) transition-opacity"
              :class="hovered !== null && hovered !== i ? 'opacity-40' : ''"
              :style="{ height: height(values[i]!) }"
            />
          </div>
        </div>
        <div
          v-if="hovered !== null"
          class="pointer-events-none absolute top-0 z-10 rounded-md border border-(--ui-border) bg-(--ui-bg) px-2.5 py-1.5 text-xs whitespace-nowrap shadow-md"
          :style="tooltipStyle"
        >
          <p class="text-(--ui-text-muted)">{{ formatDay(days[hovered]!.date) }}</p>
          <p class="font-semibold">{{ format(values[hovered]!) }}</p>
          <p v-for="line in details(days[hovered]!)" :key="line" class="text-(--ui-text-muted)">{{ line }}</p>
        </div>
      </div>
      <div class="relative mt-1 h-4 text-xs text-(--ui-text-muted)">
        <span
          v-for="i in labelled"
          :key="i"
          class="absolute whitespace-nowrap"
          :style="{ left: `${((i + 0.5) / days.length) * 100}%`, transform: i === 0 ? 'translateX(-25%)' : i === days.length - 1 ? 'translateX(-75%)' : 'translateX(-50%)' }"
        >
          {{ formatDay(days[i]!.date) }}
        </span>
      </div>
    </div>
  </div>
</template>
