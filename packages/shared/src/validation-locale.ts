import type { Locale } from '@kvitok/i18n';
import { z } from 'zod';

/** Built-in zod messages in the interface language; custom messages of the schemas come from the catalog. */
export function configureValidationLocale(locale: Locale): void {
  z.config(locale === 'ru' ? z.locales.ru() : z.locales.en());
}
