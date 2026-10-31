import { t as translate, tp as translatePlural, type MessageKey, type MessageParams, type PluralKey } from '@kvitok/i18n';

/** Message from the catalog in the installation language (packages/i18n/locales). Auto-imported in scripts and templates. */
export function t(key: MessageKey, params?: MessageParams): string {
  return translate(key, params);
}

/** Plural message for `count`. */
export function tp(key: PluralKey, count: number, params?: MessageParams): string {
  return translatePlural(key, count, params);
}
