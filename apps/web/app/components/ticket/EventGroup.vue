<script setup lang="ts">
import type { TicketEventDto } from '@kvitok/shared';
import type { EventLookups } from '~/utils/events';

/** A run of ticket events between messages: one event is a plain line, several collapse into a summary that expands. */
const props = defineProps<{ events: TicketEventDto[]; lookups: EventLookups }>();

const open = ref(false);
const first = computed(() => props.events[0]!);
const last = computed(() => props.events[props.events.length - 1]!);
const icons = computed(() => [...new Set(props.events.map(eventIcon))]);
const summary = computed(() => eventsSummary(props.events, props.lookups).join(' · '));
</script>

<template>
  <div
    v-if="events.length === 1"
    class="flex items-center justify-center gap-1.5 text-xs"
    :class="isAlertEvent(first) ? 'text-(--ui-error)' : 'text-(--ui-text-muted)'"
  >
    <UIcon :name="eventIcon(first)" class="size-3.5 shrink-0" />
    <span class="truncate">{{ eventText(first, lookups) }}</span>
    <span v-if="eventActor(first)" class="shrink-0">· {{ eventActor(first) }}</span>
    <span class="shrink-0" :title="formatDateTime(first.createdAt)">· {{ formatRelative(first.createdAt) }}</span>
  </div>

  <div v-else>
    <button
      type="button"
      class="mx-auto flex max-w-full items-center gap-2 rounded-full px-2.5 py-1 text-xs text-(--ui-text-muted) transition-colors hover:bg-(--ui-bg-elevated) hover:text-(--ui-text-toned)"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="flex shrink-0">
        <span
          v-for="icon in icons.slice(0, 4)"
          :key="icon"
          class="-ml-1.5 flex size-5 items-center justify-center rounded-full bg-(--ui-bg) ring-1 ring-(--ui-border) first:ml-0"
        >
          <UIcon :name="icon" class="size-3" />
        </span>
      </span>
      <span v-if="summary" class="truncate" :title="summary">{{ summary }} ·</span>
      <span class="shrink-0" :title="formatDateTime(last.createdAt)">{{ tp('events.group.count', events.length) }} · {{ formatRelative(last.createdAt) }}</span>
      <UIcon name="i-lucide-chevron-down" class="size-3.5 shrink-0 transition-transform" :class="open ? 'rotate-180' : ''" />
    </button>

    <ul v-if="open" class="mx-auto mt-2 max-w-xl space-y-1.5 border-l border-(--ui-border) pl-4 text-xs text-(--ui-text-muted)">
      <li v-for="event in events" :key="event.id" class="flex items-start gap-1.5">
        <UIcon :name="eventIcon(event)" class="mt-px size-3.5 shrink-0" />
        <span>
          {{ eventText(event, lookups) }}
          <span v-if="eventActor(event)">· {{ eventActor(event) }}</span>
          · {{ formatDateTime(event.createdAt) }}
        </span>
      </li>
    </ul>
  </div>
</template>
