import { DEFAULT_LOCALE, isLocale, setLocale } from '@kvitok/i18n';

/**
 * The interface language is one per installation and comes from the API (APP_LOCALE).
 * It is resolved before the app renders, so messages never switch language on screen.
 */
export default defineNuxtPlugin(async () => {
  const meta = await $fetch<{ locale?: string }>('/api/meta').catch(() => null);
  const locale = isLocale(meta?.locale) ? meta.locale : DEFAULT_LOCALE;
  setLocale(locale);
  useHead({ htmlAttrs: { lang: locale } });
});
