<script setup lang="ts">
/** The running version next to the logo, a link to the source on GitHub. */
const REPOSITORY_URL = 'https://github.com/Rogue85/kvitok';

const version = useVersion();
/** Releases are semver ("0.1.0" → "v0.1.0"); a development build reports a word such as "dev". */
const label = computed(() => (version.value && /^\d/.test(version.value) ? `v${version.value}` : version.value));
</script>

<template>
  <a
    v-if="label"
    :href="REPOSITORY_URL"
    target="_blank"
    rel="noopener"
    :title="t('common.sourceOnGithub')"
    class="relative -top-px font-mono text-[11px] leading-none text-(--ui-text-dimmed) transition-colors hover:text-(--ui-text-highlighted)"
  >
    {{ label }}
  </a>
</template>
