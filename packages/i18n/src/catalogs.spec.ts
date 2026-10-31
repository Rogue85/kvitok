import { describe, expect, it } from 'vitest';
import { LOCALES, messages, PLURAL_CATEGORIES, translate, translatePlural, type Locale } from './index';

type Leaf = string | Record<string, string>;

function isPlural(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && 'other' in value && Object.keys(value).every((k) => (PLURAL_CATEGORIES as readonly string[]).includes(k));
}

/** Plain messages and plural messages (as a whole) by dotted key. */
function leaves(node: unknown, prefix = ''): Map<string, Leaf> {
  const result = new Map<string, Leaf>();
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string' || isPlural(value)) result.set(path, value);
    else for (const [k, v] of leaves(value, path)) result.set(k, v);
  }
  return result;
}

function placeholders(leaf: Leaf): string {
  const texts = typeof leaf === 'string' ? [leaf] : Object.values(leaf);
  const names = new Set(texts.flatMap((text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!)));
  if (typeof leaf !== 'string') names.add('count');
  return [...names].sort().join();
}

const catalogs = Object.fromEntries(LOCALES.map((locale) => [locale, leaves(messages[locale])])) as Record<Locale, Map<string, Leaf>>;
const others = LOCALES.filter((l) => l !== 'en');

describe('translation catalogs', () => {
  it.each(others)('%s has exactly the keys of en', (locale) => {
    const missing = [...catalogs.en.keys()].filter((k) => !catalogs[locale].has(k));
    const extra = [...catalogs[locale].keys()].filter((k) => !catalogs.en.has(k));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it.each(others)('%s uses the same placeholders as en', (locale) => {
    const mismatched = [...catalogs.en].filter(([key, leaf]) => {
      const other = catalogs[locale].get(key);
      return other !== undefined && placeholders(other) !== placeholders(leaf);
    });
    expect(mismatched.map(([key]) => key)).toEqual([]);
  });

  it.each(LOCALES)('%s has every plural category its language needs and no empty messages', (locale) => {
    const needed = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
    const broken = [...catalogs[locale]].filter(([, leaf]) =>
      typeof leaf === 'string' ? leaf.trim() === '' : needed.some((category) => !leaf[category]?.trim()),
    );
    expect(broken.map(([key]) => key)).toEqual([]);
  });
});

describe('translate', () => {
  it('interpolates params and falls back to the key', () => {
    expect(translate('en', 'validation.minLength', { min: 16 })).toContain('16');
    expect(translate('ru', 'validation.minLength', { min: 16 })).toContain('16');
    expect(translate('en', 'missing.key' as never)).toBe('missing.key');
  });

  it('picks plural forms by language rules', () => {
    expect(translatePlural('en', 'outbox.cleared', 1)).toBe('1 email deleted');
    expect(translatePlural('en', 'outbox.cleared', 2)).toBe('2 emails deleted');
    expect(translatePlural('ru', 'outbox.cleared', 21)).toBe('Удалено 21 письмо');
    expect(translatePlural('ru', 'outbox.cleared', 3)).toBe('Удалено 3 письма');
    expect(translatePlural('ru', 'outbox.cleared', 5)).toBe('Удалено 5 писем');
  });
});
