<script setup lang="ts">
import { getLocale } from '@kvitok/i18n';
import { en, ru } from '@nuxt/ui/locale';

const uiLocale = getLocale() === 'ru' ? ru : en;
</script>

<template>
  <UApp :locale="uiLocale">
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
