/** CLDR plural categories; a plural message is an object with the categories its language needs. */
export const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;
export type PluralForms = { other: string } & Partial<Record<(typeof PLURAL_CATEGORIES)[number], string>>;
