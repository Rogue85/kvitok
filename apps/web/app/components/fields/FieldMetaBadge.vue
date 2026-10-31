<script setup lang="ts">
import type { FieldMetaEntry } from '@kvitok/shared';

const props = defineProps<{ meta?: FieldMetaEntry }>();

const ICONS: Record<FieldMetaEntry['source'], string> = {
  operator: 'i-lucide-user',
  agent: 'i-lucide-sparkles',
  ingest: 'i-lucide-download',
  rule: 'i-lucide-git-branch',
  integration: 'i-lucide-plug',
};

const tooltip = computed(() => {
  if (!props.meta) return '';
  const parts = [t(`fieldSource.${props.meta.source}`)];
  if (props.meta.confidence !== undefined) parts.push(t('fieldSource.confidence', { percent: Math.round(props.meta.confidence * 100) }));
  if (props.meta.evidence) parts.push(`«${props.meta.evidence}»`);
  if (props.meta.locked) parts.push(t('fieldSource.locked'));
  return parts.join(' · ');
});
</script>

<template>
  <UTooltip v-if="meta" :text="tooltip">
    <span class="inline-flex items-center gap-0.5 text-(--ui-text-dimmed)">
      <UIcon :name="ICONS[meta.source]" class="size-3.5" />
      <UIcon v-if="meta.locked" name="i-lucide-lock" class="size-3" />
    </span>
  </UTooltip>
</template>
