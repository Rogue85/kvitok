/**
 * The simulator speaks one language per run: the dataset (`scenarios/<locale>`, `content/<locale>`)
 * and every text the agent or the operator sees — tool and action descriptions, previews, errors.
 * Both datasets describe the same world: ids, numbers, dates and expectations are identical.
 */
export const SIM_LOCALES = ['en', 'ru'] as const;
export type SimLocale = (typeof SIM_LOCALES)[number];
export const DEFAULT_SIM_LOCALE: SimLocale = 'en';

export type Texts = Record<SimLocale, string>;

/** A picker for one language: `l({ en: 'Receipts', ru: 'Чеки' })`. */
export type Localize = (texts: Texts) => string;
export const localizer =
  (locale: SimLocale): Localize =>
  (texts) =>
    texts[locale];

export function parseSimLocale(value: string | undefined): SimLocale | undefined {
  if (value === undefined || value === '') return undefined;
  if (!(SIM_LOCALES as readonly string[]).includes(value)) throw new Error(`Unknown simulator locale "${value}", expected one of: ${SIM_LOCALES.join(', ')}`);
  return value as SimLocale;
}
