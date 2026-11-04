import type { ContextResponse, DataResult, Display } from '@kvitok/protocol';
import { z } from 'zod';
import { DEFAULT_SIM_LOCALE, localizer, type Localize, type SimLocale } from './locale.js';
import type { Coupon, Guest, SimStore, Transaction } from './store.js';
import { formatLocal } from './world.js';

/** An error the server turns into a protocol response. */
export class SimError extends Error {
  constructor(
    readonly code: 'not_found' | 'unknown_customer' | 'invalid_arguments',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface ToolContext {
  store: SimStore;
  guest: Guest | null;
}

export interface SimTool<S extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  input: S;
  display: Display;
  requiresCustomer: boolean;
  cacheTtlSeconds: number;
  examples: Array<{ title?: string; args: Record<string, unknown> }>;
  run(ctx: ToolContext, args: z.infer<S>): DataResult;
}

const defineTool = <S extends z.ZodType>(tool: SimTool<S>): SimTool<S> => tool;

const DateArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

function guestOf(ctx: ToolContext, l: Localize): Guest {
  if (!ctx.guest) throw new SimError('unknown_customer', l({ en: 'A customer is required', ru: 'Нужен клиент' }));
  return ctx.guest;
}

function ownTransaction(ctx: ToolContext, id: string, l: Localize): Transaction {
  const transaction = ctx.store.transactions.get(id);
  // Another guest's receipt is indistinguishable from a nonexistent one: the agent cannot learn about another guest's data.
  if (!transaction || transaction.guestId !== guestOf(ctx, l).id || transaction.at > ctx.store.now) {
    throw new SimError('not_found', l({ en: `Receipt ${id} not found for this guest`, ru: `Чек ${id} не найден у этого гостя` }));
  }
  return transaction;
}

export function transactionRow(store: SimStore, t: Transaction) {
  const tz = store.base.timezone;
  return {
    id: t.id,
    datetime: formatLocal(t.at, tz),
    place_id: t.placeId,
    place: store.places.get(t.placeId)?.name ?? t.placeId,
    city: store.places.get(t.placeId)?.city ?? null,
    receipt_number: t.receiptNumber,
    total: t.total,
    balance_add: t.balanceAdd,
    balance_writeoff: t.balanceWriteoff,
    paid_with: t.paidWithCoupon ? 'coupon' : t.paidWithDeposit ? 'deposit' : 'money',
    cups_counted: t.cupsCounted,
  };
}

function couponRow(store: SimStore, c: Coupon) {
  const tz = store.base.timezone;
  return {
    id: c.id,
    number: c.number,
    type: store.couponTypes.get(c.typeId)?.name ?? c.typeId,
    type_id: c.typeId,
    status: store.couponStatus(c),
    created_at: formatLocal(c.createdAt, tz),
    active_before: formatLocal(c.activeBefore, tz),
    used_at: c.usedAt ? formatLocal(c.usedAt, tz) : null,
    source: c.source,
    promo_id: c.promoId,
  };
}

export function cupsProgress(store: SimStore, guest: Guest) {
  const tz = store.base.timezone;
  const ledger = store.cupsLedger(guest.id);
  const cupsCoupons = store.couponsOf(guest.id).filter((c) => c.typeId === store.base.cups.coupon_type);
  const lastWriteoff = ledger.filter((e) => e.reason === 'writeoff').at(-1);
  return {
    active_cups: store.activeCups(guest.id),
    cups_for_coupon: store.base.cups.cups_for_coupon,
    period: `${store.base.cups.period_from} — ${store.base.cups.period_to}`,
    active_coupons: cupsCoupons.filter((c) => store.couponStatus(c) === 'active').length,
    used_coupons: cupsCoupons.filter((c) => store.couponStatus(c) === 'used').length,
    last_coupon_at: cupsCoupons[0] ? formatLocal(cupsCoupons[0].createdAt, tz) : null,
    last_write_off_at: lastWriteoff ? formatLocal(lastWriteoff.at, tz) : null,
    manual_accruals: ledger.filter((e) => e.reason === 'manual').length,
    ledger: ledger.slice(-20).map((e) => ({ at: formatLocal(e.at, tz), delta: e.delta, reason: e.reason, transaction_id: e.transactionId })),
  };
}

/** The simulator tools with descriptions and messages in one language. */
export function simTools(locale: SimLocale = DEFAULT_SIM_LOCALE): SimTool[] {
  const l = localizer(locale);
  return [
    defineTool({
      name: 'get_transactions',
      title: l({ en: 'Guest receipts', ru: 'Чеки гостя' }),
      description: l({
        en: "Receipts registered on the guest's loyalty card, newest first: total, points credited (balance_add) and written off (balance_writeoff), how it was paid, how many cups were counted. If the purchase from the ticket is not here, the receipt was most likely not registered on the card.",
        ru: 'Чеки, проведённые по карте лояльности гостя, новые первыми: сумма, начислено (balance_add) и списано (balance_writeoff) баллов, чем оплачен, сколько кружек засчитано. Если покупки из обращения здесь нет — чек, скорее всего, не провели по карте.',
      }),
      input: z.object({
        from: DateArg.optional().describe(l({ en: 'From this date, inclusive', ru: 'С даты, включительно' })),
        to: DateArg.optional().describe(l({ en: 'Up to this date, inclusive', ru: 'По дату, включительно' })),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      display: 'table',
      requiresCustomer: true,
      cacheTtlSeconds: 300,
      examples: [{ title: l({ en: 'Last 10 receipts', ru: 'Последние 10 чеков' }), args: { limit: 10 } }],
      run(ctx, args) {
        const guest = guestOf(ctx, l);
        const from = args.from ? ctx.store.time(args.from) : null;
        const to = args.to ? ctx.store.time(`${args.to} 23:59:59`) : null;
        const rows = ctx.store
          .transactionsOf(guest.id)
          .filter((t) => (!from || t.at >= from) && (!to || t.at <= to))
          .slice(0, args.limit)
          .map((t) => transactionRow(ctx.store, t));
        return {
          summary: rows.length ? l({ en: `Receipts: ${rows.length}`, ru: `Чеков: ${rows.length}` }) : l({ en: 'No receipts on the card for the period', ru: 'Чеков по карте за период нет' }),
          data: rows,
          display: 'table',
          refs: [],
        };
      },
    }),
    defineTool({
      name: 'get_receipt',
      title: l({ en: 'Receipt items', ru: 'Состав чека' }),
      description: l({
        en: 'Receipt items (name, group, price, quantity, discount) and how the receipt counted towards the "6th cup free": drinks — paid drinks, counted — counted, uncounted_drinks — not counted, excluded — why the receipt does not take part (coupon, deposit, out_of_period).',
        ru: 'Позиции чека (название, группа, цена, количество, скидка) и как чек засчитан в «6-ю кружку»: drinks — оплаченных напитков, counted — засчитано, uncounted_drinks — не засчитано, excluded — почему чек не участвует (coupon, deposit, out_of_period).',
      }),
      input: z.object({ transaction_id: z.string().min(1) }),
      display: 'kv',
      requiresCustomer: true,
      cacheTtlSeconds: 3600,
      examples: [],
      run(ctx, args) {
        const t = ownTransaction(ctx, args.transaction_id, l);
        return {
          data: {
            ...transactionRow(ctx.store, t),
            paid_with_coupon_id: t.paidWithCoupon,
            items: t.items.map((i) => ({ name: i.name, group: i.group, price: i.price, amount: i.amount, discount_price: i.discount_price ?? null })),
            cups: { drinks: t.drinks, counted: t.cupsCounted, uncounted_drinks: Math.max(0, t.drinks - t.cupsCounted), excluded: t.cupsExcluded },
          },
          display: 'kv',
          refs: [{ type: 'transaction', id: t.id, title: l({ en: `Receipt ${t.receiptNumber}`, ru: `Чек ${t.receiptNumber}` }) }],
        };
      },
    }),
    defineTool({
      name: 'get_promo_journal',
      title: l({ en: 'Promo journal for receipts', ru: 'Журнал акций по чекам' }),
      description: l({
        en: 'How promos processed the receipts: journal lines ("(Item) - found, cashback=N", "Total cashback: N", "Applied: 1", "Coupons: N") and applied — whether the promo fired. No entry for a promo — the promo did not consider the receipt (coffee shop, weekday, paid with a coupon).',
        ru: 'Как акции обработали чеки: строки журнала («(Товар) - found, cashback=N», «Total cashback: N», «Applied: 1», «Coupons: N») и applied — сработала ли акция. Нет записи по акции — акция чек не рассматривала (точка, день недели, оплата купоном).',
      }),
      input: z.object({ transaction_ids: z.array(z.string().min(1)).min(1).max(10) }),
      display: 'timeline',
      requiresCustomer: true,
      cacheTtlSeconds: 3600,
      examples: [],
      run(ctx, args) {
        const entries = args.transaction_ids.flatMap((id) =>
          ownTransaction(ctx, id, l).journal.map((j) => ({
            transaction_id: id,
            promo_id: j.promoId,
            promo: ctx.store.promos.get(j.promoId)?.name ?? j.promoId,
            applied: j.applied,
            journal: j.lines,
          })),
        );
        return {
          summary: entries.length ? undefined : l({ en: 'No promo journal entries for these receipts', ru: 'По этим чекам записей в журнале акций нет' }),
          data: entries,
          display: 'timeline',
          refs: [],
        };
      },
    }),
    defineTool({
      name: 'get_promos',
      title: l({ en: 'Promos', ru: 'Акции' }),
      description: l({
        en: 'Promos active on a date: type, period, weekdays, coffee shops, which coupon they issue. Type increased_cashback — increased cashback, coupon_for_* — a coupon.',
        ru: 'Акции, действующие на дату: тип, период, дни недели, кофейни, какой купон выдают. Тип increased_cashback — повышенный кэшбек, coupon_for_* — купон.',
      }),
      input: z.object({ date: DateArg.optional().describe(l({ en: 'Today by default', ru: 'По умолчанию — сегодня' })) }),
      display: 'table',
      requiresCustomer: false,
      cacheTtlSeconds: 3600,
      examples: [{ title: l({ en: 'Promos today', ru: 'Акции сегодня' }), args: {} }],
      run(ctx, args) {
        const date = args.date ? ctx.store.time(`${args.date} 12:00`) : ctx.store.now;
        const promos = ctx.store.promosActiveAt(date).map((p) => ({
          id: p.id,
          name: p.name,
          type: p.type,
          description: p.description,
          active_from: p.active_from,
          active_to: p.active_to,
          weekdays: p.weekdays,
          places: p.places.map((id) => ctx.store.places.get(id)?.name ?? id),
          coupon: p.coupon_type ? (ctx.store.couponTypes.get(p.coupon_type)?.name ?? p.coupon_type) : null,
        }));
        return { data: promos, display: 'table', refs: [] };
      },
    }),
    defineTool({
      name: 'get_coupons',
      title: l({ en: 'Guest coupons', ru: 'Купоны гостя' }),
      description: l({
        en: "The guest's coupons, newest first: type, status (active, used, expired), when issued and valid until, source (promo, cups, support, birthday).",
        ru: 'Купоны гостя, новые первыми: тип, статус (active, used, expired), когда выдан и до когда действует, источник (promo, cups, support, birthday).',
      }),
      input: z.object({ include_inactive: z.boolean().default(false).describe(l({ en: 'Include used and expired ones', ru: 'Показать использованные и истёкшие' })) }),
      display: 'table',
      requiresCustomer: true,
      cacheTtlSeconds: 300,
      examples: [{ title: l({ en: 'All coupons', ru: 'Все купоны' }), args: { include_inactive: true } }],
      run(ctx, args) {
        const guest = guestOf(ctx, l);
        const rows = ctx.store
          .couponsOf(guest.id)
          .filter((c) => args.include_inactive || ctx.store.couponStatus(c) === 'active')
          .map((c) => couponRow(ctx.store, c));
        return { data: rows, display: 'table', refs: [] };
      },
    }),
    defineTool({
      name: 'get_cups_progress',
      title: l({ en: '"6th cup free"', ru: '«6-я кружка в подарок»' }),
      description: l({
        en: 'State of the "6th cup" promo: cups collected, how many are needed for a coupon, active and used free drink coupons, when cups were last written off, manual credits and the cups ledger.',
        ru: 'Состояние акции «6-я кружка»: накоплено кружек, сколько нужно для купона, активные и использованные купоны на подарочный напиток, когда последний раз списывались кружки, ручные начисления и журнал движения кружек.',
      }),
      input: z.object({}),
      display: 'kv',
      requiresCustomer: true,
      cacheTtlSeconds: 300,
      examples: [{ args: {} }],
      run(ctx) {
        return { data: cupsProgress(ctx.store, guestOf(ctx, l)), display: 'kv', refs: [] };
      },
    }),
    defineTool({
      name: 'get_orders',
      title: l({ en: 'Pickup orders', ru: 'Заказы самовывоза' }),
      description: l({
        en: "The guest's app orders, newest first: coffee shop, number, items, total, status (paid, preparing, ready, completed, cancelled, refunded) and the time of payment, readiness, hand-over.",
        ru: 'Заказы гостя в приложении, новые первыми: кофейня, номер, состав, сумма, статус (paid, preparing, ready, completed, cancelled, refunded) и время оплаты, готовности, выдачи.',
      }),
      input: z.object({ limit: z.number().int().min(1).max(20).default(10) }),
      display: 'table',
      requiresCustomer: true,
      cacheTtlSeconds: 120,
      examples: [{ args: { limit: 5 } }],
      run(ctx, args) {
        const tz = ctx.store.base.timezone;
        const rows = ctx.store
          .ordersOf(guestOf(ctx, l).id)
          .slice(0, args.limit)
          .map((o) => ({
            id: o.id,
            number: o.number,
            place_id: o.placeId,
            place: ctx.store.places.get(o.placeId)?.name ?? o.placeId,
            status: o.status,
            total: o.total,
            items: o.items,
            payment_method: o.payment_method,
            created_at: formatLocal(o.createdAt, tz),
            paid_at: o.paidAt ? formatLocal(o.paidAt, tz) : null,
            ready_at: o.readyAt ? formatLocal(o.readyAt, tz) : null,
            issued_at: o.issuedAt ? formatLocal(o.issuedAt, tz) : null,
            refunded_at: o.refundedAt ? formatLocal(o.refundedAt, tz) : null,
          }));
        return { data: rows, display: 'table', refs: [] };
      },
    }),
  ];
}

/** Guest card for `/context`. */
export function buildContext(store: SimStore, guest: Guest, locale: SimLocale = DEFAULT_SIM_LOCALE): ContextResponse {
  const l = localizer(locale);
  const tz = store.base.timezone;
  const since = formatLocal(guest.registeredAt, tz).slice(0, 10);
  const activeCoupons = store.couponsOf(guest.id).filter((c) => store.couponStatus(c) === 'active');
  return {
    title: guest.name,
    summary: l({
      en: `Guest since ${since}, cashback ${guest.cashbackPercent}%, balance ${guest.balance} points`,
      ru: `Гость с ${since}, кэшбек ${guest.cashbackPercent}%, баланс ${guest.balance} баллов`,
    }),
    sections: [
      {
        key: 'profile',
        title: l({ en: 'Profile', ru: 'Профиль' }),
        display: 'kv',
        data: {
          id: guest.id,
          name: guest.name,
          card_number: guest.cardNumber,
          city: guest.city,
          registered_at: since,
          cashback_percent: guest.cashbackPercent,
          balance: guest.balance,
        },
      },
      { key: 'cups', title: l({ en: '"6th cup"', ru: '«6-я кружка»' }), display: 'kv', data: (({ ledger: _, ...rest }) => rest)(cupsProgress(store, guest)) },
      { key: 'coupons', title: l({ en: 'Active coupons', ru: 'Активные купоны' }), display: 'table', data: activeCoupons.map((c) => couponRow(store, c)) },
      { key: 'transactions', title: l({ en: 'Recent receipts', ru: 'Последние чеки' }), display: 'table', data: store.transactionsOf(guest.id).slice(0, 5).map((t) => transactionRow(store, t)) },
    ],
    refs: [{ type: 'guest', id: guest.id, title: guest.name }],
    fields: { cashback_percent: guest.cashbackPercent, balance: guest.balance, city: guest.city },
  };
}
