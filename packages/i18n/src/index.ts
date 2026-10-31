import { en, ru, type Messages } from './generated/messages';
import { PLURAL_CATEGORIES, type PluralForms } from './plural';

export { PLURAL_CATEGORIES, type Messages, type PluralForms };

export const LOCALES = ['en', 'ru'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

/** The English catalog is the source of truth: `Messages` is derived from it, the other languages are checked against it. */
export const messages: Record<Locale, Messages> = { en, ru };

type Keys<T, Prefix extends string, Plural extends boolean> = {
  [K in keyof T & string]: T[K] extends string
    ? Plural extends false
      ? `${Prefix}${K}`
      : never
    : T[K] extends { other: string }
      ? Plural extends true
        ? `${Prefix}${K}`
        : never
      : Keys<T[K], `${Prefix}${K}.`, Plural>;
}[keyof T & string];

/** Dotted key of a plain message, e.g. `errors.notFound`. */
export type MessageKey = Keys<Messages, '', false>;
/** Dotted key of a plural message, e.g. `tickets.count`. */
export type PluralKey = Keys<Messages, '', true>;
export type MessageParams = Record<string, string | number>;

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Formats a message: `{name}` is replaced with `params.name`. */
export function translate(locale: Locale, key: MessageKey, params: MessageParams = {}): string {
  const message = lookup(messages[locale], key) ?? lookup(messages[DEFAULT_LOCALE], key);
  return typeof message === 'string' ? interpolate(message, params) : key;
}

/** Picks the plural form for `count` by the rules of the language; `{count}` is available in the message. */
export function translatePlural(locale: Locale, key: PluralKey, count: number, params: MessageParams = {}): string {
  const forms = (lookup(messages[locale], key) ?? lookup(messages[DEFAULT_LOCALE], key)) as PluralForms | undefined;
  if (forms === undefined || typeof forms !== 'object') return key;
  const category = new Intl.PluralRules(locale).select(count) as keyof PluralForms;
  return interpolate(forms[category] ?? forms.other, { count, ...params });
}

let current: Locale = DEFAULT_LOCALE;

/** The interface language of this installation; set once at startup by the API and the web app. */
export function setLocale(locale: Locale): void {
  current = locale;
}

export function getLocale(): Locale {
  return current;
}

/** `translate` in the current locale. */
export function t(key: MessageKey, params?: MessageParams): string {
  return translate(current, key, params);
}

/** `translatePlural` in the current locale. */
export function tp(key: PluralKey, count: number, params?: MessageParams): string {
  return translatePlural(current, key, count, params);
}

function interpolate(message: string, params: MessageParams): string {
  return message.replace(/\{(\w+)\}/g, (match, name: string) => (params[name] === undefined ? match : String(params[name])));
}

function lookup(catalog: unknown, key: string): unknown {
  let node = catalog;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}
