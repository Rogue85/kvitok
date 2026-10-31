import { z } from 'zod';

/**
 * The simulator world: reference data (_base.yaml) and scenario data.
 * Times are local everywhere, without an offset: "2026-10-14 15:22" or "2026-10-14T15:22" — in the world's time zone.
 */

const Id = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/, 'lowercase latin letters, digits, _ . -');
const LocalDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/, 'YYYY-MM-DD HH:mm');
const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const Money = z.number().nonnegative();

export const PlaceSchema = z.object({ id: Id, name: z.string().min(1), city: z.string().min(1) });

export const CouponTypeSchema = z.object({
  id: Id,
  name: z.string().min(1),
  /** Validity of an issued coupon. */
  days: z.number().int().positive().default(30),
});

export const PROMO_TYPES = ['increased_cashback', 'coupon_for_total', 'coupon_for_products', 'coupon_for_accumulated_products'] as const;

export const PromoSchema = z.object({
  id: Id,
  name: z.string().min(1),
  type: z.enum(PROMO_TYPES),
  description: z.string().default(''),
  active_from: LocalDate,
  active_to: LocalDate,
  /** For coupon promos — which coupon is issued. */
  coupon_type: Id.optional(),
  /** ISO weekdays (1 = Mon), empty — every day. */
  weekdays: z.array(z.number().int().min(1).max(7)).default([]),
  /** Only in these coffee shops, empty — in all of them. */
  places: z.array(Id).default([]),
});

export const CupsRulesSchema = z.object({
  period_from: LocalDate,
  period_to: LocalDate,
  cups_for_coupon: z.number().int().positive().default(5),
  coupon_type: Id,
  /** Item groups that count as drinks. */
  drink_groups: z.array(z.string()).min(1),
});

export const BaseWorldSchema = z.object({
  /** Time zone offset of the world: "+03:00". */
  timezone: z.string().regex(/^[+-]\d{2}:\d{2}$/),
  /** The frozen "now" of the world: all scenarios live in the same moment. */
  now: LocalDateTime,
  places: z.array(PlaceSchema).min(1),
  /** City of the guests whose scenario does not name one. */
  guest_city: z.string().min(1),
  coupon_types: z.array(CouponTypeSchema).default([]),
  promos: z.array(PromoSchema).default([]),
  cups: CupsRulesSchema,
  limits: z
    .object({
      max_points: z.number().int().positive().default(1000),
      max_coupons: z.number().int().positive().default(3),
      max_cups: z.number().int().positive().default(3),
    })
    .default({ max_points: 1000, max_coupons: 3, max_cups: 3 }),
});
export type BaseWorld = z.infer<typeof BaseWorldSchema>;

export const GuestSchema = z.object({
  id: Id,
  name: z.string().min(1),
  phone: z.string().regex(/^7\d{10}$/, '11 digits starting with 7'),
  email: z.email().optional(),
  card_number: z.string().regex(/^\d{6,12}$/).optional(),
  cashback_percent: z.number().int().min(0).max(30).default(5),
  balance: Money.default(0),
  registered_at: LocalDate.default('2024-03-01'),
  /** By default — `guest_city` of the world. */
  city: z.string().optional(),
});
export type GuestInput = z.infer<typeof GuestSchema>;

export const ReceiptItemSchema = z.object({
  name: z.string().min(1),
  group: z.string().min(1),
  price: Money,
  amount: z.number().int().positive().default(1),
  /** The discounted price, if there was one. */
  discount_price: Money.optional(),
});

export const JournalEntrySchema = z.object({
  promo: Id,
  /** Journal lines as the promo engine would write them: "(Pumpkin latte) - found, cashback=24". */
  lines: z.array(z.string()).min(1),
  applied: z.boolean().default(false),
});

export const TransactionSchema = z.object({
  id: Id,
  guest: Id,
  at: LocalDateTime,
  place: Id,
  receipt_number: z.string().optional(),
  total: Money,
  /** How many points were credited; by default the guest's cashback from the total. */
  balance_add: Money.optional(),
  balance_writeoff: Money.default(0),
  /** The receipt was paid with a coupon (coupon id) — promos and cups do not apply. */
  paid_with_coupon: Id.optional(),
  paid_with_deposit: z.boolean().default(false),
  items: z.array(ReceiptItemSchema).min(1),
  /** How many cups were counted; by default by the promo rules. */
  cups_counted: z.number().int().min(0).optional(),
  promo_journal: z.array(JournalEntrySchema).default([]),
});
export type TransactionInput = z.infer<typeof TransactionSchema>;

export const CouponSchema = z.object({
  id: Id,
  guest: Id,
  type: Id,
  created_at: LocalDateTime,
  active_before: LocalDateTime.optional(),
  used_at: LocalDateTime.optional(),
  source: z.enum(['promo', 'cups', 'support', 'birthday']).default('promo'),
  promo: Id.optional(),
});

/** Cup movements outside receipts: opening balance, write-off for a coupon, manual credit. */
export const CupsEntrySchema = z.object({
  guest: Id,
  at: LocalDateTime,
  delta: z.number().int(),
  reason: z.enum(['opening', 'writeoff', 'manual']),
});

export const ORDER_STATUSES = ['created', 'paid', 'preparing', 'ready', 'completed', 'cancelled', 'refunded'] as const;

export const OrderSchema = z.object({
  id: Id,
  guest: Id,
  place: Id,
  number: z.string().min(1),
  created_at: LocalDateTime,
  status: z.enum(ORDER_STATUSES),
  total: Money,
  items: z.array(z.object({ name: z.string().min(1), price: Money, amount: z.number().int().positive().default(1) })).min(1),
  payment_method: z.enum(['card', 'sbp', 'points']).default('card'),
  paid_at: LocalDateTime.optional(),
  ready_at: LocalDateTime.optional(),
  issued_at: LocalDateTime.optional(),
  refunded_at: LocalDateTime.optional(),
});

/** An expected action: parameters are compared only by the given keys. */
export const ExpectedActionSchema = z.object({ type: z.string().min(1), params: z.record(z.string(), z.unknown()).default({}) });

export const ScenarioSchema = z.object({
  id: Id,
  title: z.string().min(1),
  tags: z.array(z.string()).default([]),
  guests: z.array(GuestSchema).default([]),
  transactions: z.array(TransactionSchema).default([]),
  coupons: z.array(CouponSchema).default([]),
  cups: z.array(CupsEntrySchema).default([]),
  orders: z.array(OrderSchema).default([]),
  ticket: z.object({
    /** The scenario guest — identities come from their profile. */
    customer: Id.optional(),
    /** Explicit identities: e.g. a phone that is not in the database. */
    identities: z.record(z.string(), z.string()).optional(),
    name: z.string().optional(),
    subject: z.string().min(1),
    body: z.string().min(1),
    sent_at: LocalDateTime,
  }),
  expect: z.object({
    /** A department or several acceptable ones (e.g. a suspicious email may go to a department or to triage). */
    department: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    /** Actions the agent must propose. */
    actions: z.array(ExpectedActionSchema).default([]),
    /** Actions that must not be proposed. */
    forbid_actions: z.array(z.string()).default([]),
    needs_human: z.boolean().optional(),
    /** An explanation for humans: why this is the expectation. */
    note: z.string().optional(),
  }),
});
export type Scenario = z.infer<typeof ScenarioSchema>;
export type ScenarioInput = z.input<typeof ScenarioSchema>;

/* ───────────── time ───────────── */

/** Local world time → Date. */
export function parseLocal(value: string, timezone: string): Date {
  const normalized = value.replace(' ', 'T');
  const withSeconds = /T\d{2}:\d{2}$/.test(normalized) ? `${normalized}:00` : /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? `${normalized}T00:00:00` : normalized;
  return new Date(`${withSeconds}${timezone}`);
}

/** Date → "YYYY-MM-DD HH:mm" in the world's time zone. */
export function formatLocal(date: Date, timezone: string): string {
  const sign = timezone.startsWith('-') ? -1 : 1;
  const [hours, minutes] = timezone.slice(1).split(':').map(Number);
  const shifted = new Date(date.getTime() + sign * ((hours ?? 0) * 60 + (minutes ?? 0)) * 60_000);
  return shifted.toISOString().slice(0, 16).replace('T', ' ');
}

/** Date → ISO with the world's offset: "2026-10-15T09:10:00+03:00". */
export function formatIsoLocal(date: Date, timezone: string): string {
  return `${formatLocal(date, timezone).replace(' ', 'T')}:00${timezone}`;
}
