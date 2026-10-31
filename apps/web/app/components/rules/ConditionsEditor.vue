<script setup lang="ts">
/** The rule condition builder: rows joined by all/any, or JSON for nested conditions. Shared by routing and identification rules. */
defineProps<{ fieldPaths: string[] }>();
const draft = defineModel<ConditionsDraft>({ required: true });
const operatorItems = ruleOperatorItems();
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-center gap-2">
      <p class="text-sm font-medium">{{ t('rules.conditions') }}</p>
      <USelect
        v-if="!draft.advanced"
        v-model="draft.match"
        :items="[
          { label: t('rules.matchAll'), value: 'all' },
          { label: t('rules.matchAny'), value: 'any' },
        ]"
        size="xs"
        class="w-24"
      />
      <UButton size="xs" variant="link" class="ml-auto" @click="draft.advanced = !draft.advanced">{{ draft.advanced ? t('rules.builder') : 'JSON' }}</UButton>
    </div>
    <UTextarea v-if="draft.advanced" v-model="draft.json" autoresize :rows="6" class="w-full font-mono text-xs" />
    <template v-else>
      <div v-for="(row, index) in draft.rows" :key="index" class="grid grid-cols-[2fr_8rem_2fr_auto] gap-2">
        <UInputMenu v-model="row.field" :items="fieldPaths" create-item size="sm" @create="(v: string) => (row.field = v)" />
        <USelect v-model="row.op" :items="operatorItems" size="sm" />
        <UInput
          v-model="row.value"
          size="sm"
          :disabled="row.op === 'is_empty' || row.op === 'is_not_empty'"
          :placeholder="row.op === 'between' ? '200, 299' : row.op === 'in' ? 'a, b, c' : ''"
        />
        <UButton icon="i-lucide-x" size="sm" color="neutral" variant="ghost" @click="draft.rows.splice(index, 1)" />
      </div>
      <UButton size="xs" variant="soft" icon="i-lucide-plus" @click="draft.rows.push({ field: fieldPaths[0] ?? 'subject', op: 'contains', value: '' })">{{ t('rules.condition') }}</UButton>
    </template>
  </div>
</template>
