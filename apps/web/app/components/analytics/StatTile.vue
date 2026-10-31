<script setup lang="ts">
defineProps<{ label: string; value: string; hint?: string }>();
</script>

<template>
  <div class="rounded-lg border border-(--ui-border) p-4">
    <p class="text-sm text-(--ui-text-muted)">{{ label }}</p>
    <p class="mt-1 truncate text-2xl font-semibold" :title="value">{{ value }}</p>
    <p v-if="hint" class="mt-1 text-xs text-(--ui-text-muted)">{{ hint }}</p>
  </div>
</template>
