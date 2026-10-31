import { z } from 'zod';
import { DEFAULT_SIM_LOCALE, localizer, type Localize, type SimLocale } from './locale.js';
import type { Guest, SimStore, Transaction } from './store.js';
import { formatLocal } from './world.js';

export interface ActionContext {
  store: SimStore;
  guest: Guest;
}

export interface ValidationOutcome<P> {
  ok: boolean;
  normalized: P;
  preview?: string;
  warnings: string[];
  errors: Array<{ path?: string; message: string }>;
}

export interface SimAction<S extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  input: S;
  examples: Array<{ title?: string; params: Record<string, unknown> }>;
  validate(ctx: ActionContext, params: z.infer<S>): ValidationOutcome<z.infer<S>>;
  execute(ctx: ActionContext, params: z.infer<S>): { result: unknown; externalRef: string };
}

const defineAction = <S extends z.ZodType>(action: SimAction<S>): SimAction<S> => action;

/** Collects errors, warnings and normalized parameters during validation. */
class Check<P> {
  readonly warnings: string[] = [];
  readonly errors: Array<{ path?: string; message: string }> = [];
  constructor(public normalized: P) {}
  error(message: string, path?: string): void {
    this.errors.push({ message, ...(path ? { path } : {}) });
  }
  warn(message: string): void {
    this.warnings.push(message);
  }
  done(preview?: string): ValidationOutcome<P> {
    const ok = this.errors.length === 0;
    return { ok, normalized: this.normalized, ...(ok && preview ? { preview } : {}), warnings: this.warnings, errors: this.errors };
  }
}

function ownTransaction(ctx: ActionContext, id: string | null, check: Check<unknown>, l: Localize): Transaction | null {
  if (id === null) return null;
  const transaction = ctx.store.transactions.get(id);
  if (!transaction || transaction.guestId !== ctx.guest.id || transaction.at > ctx.store.now) {
    check.error(l({ en: `Receipt ${id} not found for this guest`, ru: `Чек ${id} не найден у этого гостя` }), 'transaction_id');
    return null;
  }
  return transaction;
}

/** Executed actions of this guest — to detect repeats. */
function executed(ctx: ActionContext, action: string): Array<Record<string, unknown>> {
  return [...ctx.store.executions.values()]
    .filter((e) => e.action === action && e.customerRef === ctx.guest.id && e.response.status === 'executed')
    .map((e) => (e.response.result as { params: Record<string, unknown> }).params);
}

/** The simulator actions with descriptions, previews and messages in one language. */
export function simActions(locale: SimLocale = DEFAULT_SIM_LOCALE): SimAction[] {
  const l = localizer(locale);
  const cupsWord = (n: number) =>
    locale === 'ru' ? (n % 10 === 1 && n % 100 !== 11 ? 'кружку' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'кружки' : 'кружек') : n === 1 ? 'cup' : 'cups';
  const receiptLabel = (store: SimStore, t: Transaction) => {
    const at = formatLocal(t.at, store.base.timezone);
    return l({ en: `receipt ${t.receiptNumber} of ${at}`, ru: `чек ${t.receiptNumber} от ${at}` });
  };

  return [
    defineAction({
      name: 'accrue_points',
      title: l({ en: 'Credit points', ru: 'Начислить баллы' }),
      description: l({
        en: [
          'Credit points to the guest. basis:',
          "- base_cashback — base cashback by the guest's tier: amount = floor(receipt total × cashback_percent / 100). The receipt is on the card and balance_add > 0 — the points are already credited, do not propose. No receipt on the card — transaction_id = null and receipt_total from the ticket;",
          '- promo_cashback — promo cashback: amount only from the promo journal ("Total cashback: N"), promo_id is required;',
          '- writeoff_refund — return points written off for a receipt that did not go towards the payment: amount ≤ balance_writeoff of the receipt.',
        ].join('\n'),
        ru: [
          'Начислить гостю баллы. basis:',
          '- base_cashback — базовый кэшбек по уровню гостя: amount = floor(сумма чека × cashback_percent / 100). Чек есть по карте и balance_add > 0 — баллы уже начислены, не предлагай. Чека по карте нет — transaction_id = null и receipt_total из обращения;',
          '- promo_cashback — кэшбек по акции: amount только из журнала акций («Total cashback: N»), promo_id обязателен;',
          '- writeoff_refund — вернуть баллы, списанные по чеку, которые не ушли в оплату: amount ≤ balance_writeoff чека.',
        ].join('\n'),
      }),
      input: z.object({
        basis: z.enum(['base_cashback', 'promo_cashback', 'writeoff_refund']),
        amount: z.number().int().min(1).describe(l({ en: 'A whole number of points', ru: 'Целое число баллов' })),
        transaction_id: z
          .string()
          .min(1)
          .nullable()
          .default(null)
          .describe(l({ en: 'Receipt id from get_transactions; null — no receipt on the card', ru: 'id чека из get_transactions; null — чека по карте нет' })),
        receipt_total: z
          .number()
          .positive()
          .optional()
          .describe(l({ en: "The receipt total in the guest's words, if the receipt is not on the card", ru: 'Сумма чека со слов гостя, если чека нет по карте' })),
        promo_id: z.string().min(1).optional().describe(l({ en: 'For promo_cashback', ru: 'Для promo_cashback' })),
      }),
      examples: [
        { title: l({ en: 'The receipt was not registered on the card', ru: 'Чек не провели по карте' }), params: { basis: 'base_cashback', amount: 19, transaction_id: null, receipt_total: 380 } },
      ],
      validate(ctx, params) {
        const check = new Check({ ...params });
        const { store, guest } = ctx;
        const limit = store.base.limits.max_points;
        if (params.amount > limit) check.error(l({ en: `Over the limit of ${limit} points per credit`, ru: `Больше лимита ${limit} баллов за одно начисление` }), 'amount');
        const tx = ownTransaction(ctx, params.transaction_id, check, l);

        if (params.basis === 'base_cashback') {
          let expected: number | null = null;
          if (tx) {
            if (tx.balanceAdd > 0) check.error(l({ en: `Points for the receipt are already credited: ${tx.balanceAdd}`, ru: `Баллы по чеку уже начислены: ${tx.balanceAdd}` }), 'transaction_id');
            expected = Math.floor((tx.total * guest.cashbackPercent) / 100);
          } else if (params.transaction_id === null) {
            if (params.receipt_total === undefined) check.error(l({ en: "No receipt on the card — the receipt total in the guest's words is required (receipt_total)", ru: 'Чека по карте нет — нужна сумма чека со слов гостя (receipt_total)' }), 'receipt_total');
            else expected = Math.floor((params.receipt_total * guest.cashbackPercent) / 100);
          }
          if (expected !== null && expected !== params.amount) {
            check.warn(
              l({
                en: `The guest's tier (${guest.cashbackPercent}%) gives ${expected}, not ${params.amount}`,
                ru: `По уровню гостя (${guest.cashbackPercent}%) положено ${expected}, а не ${params.amount}`,
              }),
            );
            check.normalized.amount = expected;
          }
          if (expected === 0) check.error(l({ en: "The guest's tier gives no points for this total", ru: 'По уровню гостя за такую сумму баллов не положено' }), 'amount');
        }
        if (params.basis === 'promo_cashback') {
          const promo = params.promo_id ? store.promos.get(params.promo_id) : undefined;
          if (!promo)
            check.error(
              params.promo_id ? l({ en: `No promo ${params.promo_id}`, ru: `Акции ${params.promo_id} нет` }) : l({ en: 'Promo cashback requires promo_id', ru: 'Для кэшбека по акции нужен promo_id' }),
              'promo_id',
            );
          else if (promo.type !== 'increased_cashback') check.error(l({ en: `The promo "${promo.name}" is not a cashback promo`, ru: `Акция «${promo.name}» не кэшбековая` }), 'promo_id');
          else if (tx) {
            const entry = tx.journal.find((j) => j.promoId === promo.id);
            if (!entry) check.warn(l({ en: 'The journal has no entry for this promo on the receipt — check the promo conditions', ru: 'В журнале нет записи по этой акции для чека — проверьте условия акции' }));
            else if (entry.applied)
              check.warn(
                l({
                  en: 'The journal shows the promo was already applied to the receipt — check whether it was credited',
                  ru: 'Журнал показывает, что акция по чеку уже применена — проверьте, не начислено ли',
                }),
              );
          }
        }
        if (params.basis === 'writeoff_refund') {
          if (params.transaction_id === null) check.error(l({ en: 'A write-off refund requires a receipt', ru: 'Для возврата списания нужен чек' }), 'transaction_id');
          else if (tx && tx.balanceWriteoff === 0) check.error(l({ en: 'No points were written off for the receipt', ru: 'По чеку баллы не списывались' }), 'transaction_id');
          else if (tx && params.amount > tx.balanceWriteoff)
            check.error(l({ en: `${tx.balanceWriteoff} written off for the receipt, cannot return more`, ru: `По чеку списано ${tx.balanceWriteoff}, вернуть больше нельзя` }), 'amount');
        }

        const history = executed(ctx, 'accrue_points').filter((p) => p.basis === params.basis);
        if (params.transaction_id !== null && history.some((p) => p.transaction_id === params.transaction_id)) {
          check.error(l({ en: 'Support already credited points for this receipt on the same basis', ru: 'По этому чеку поддержка уже начисляла баллы с тем же основанием' }), 'transaction_id');
        } else if (params.transaction_id === null && history.some((p) => p.transaction_id === null && p.receipt_total === params.receipt_total)) {
          check.warn(l({ en: 'A similar credit without a receipt was already made — check it is not a repeat', ru: 'Похожее начисление без чека уже было — проверьте, не повтор ли' }));
        }

        const basis = l(
          {
            base_cashback: { en: 'tier cashback', ru: 'кэшбек по уровню' },
            promo_cashback: { en: 'promo cashback', ru: 'кэшбек по акции' },
            writeoff_refund: { en: 'write-off refund', ru: 'возврат списания' },
          }[params.basis],
        );
        const where = tx
          ? receiptLabel(store, tx)
          : params.receipt_total
            ? l({ en: `a ${params.receipt_total} ₽ receipt not on the card`, ru: `чек на ${params.receipt_total} ₽ не по карте` })
            : '';
        const details = `${basis}${where ? `, ${where}` : ''}`;
        const amount = check.normalized.amount;
        return check.done(l({ en: `Credit ${amount} points (${details}) — ${guest.name}`, ru: `Начислить ${amount} баллов (${details}) — ${guest.name}` }));
      },
      execute(ctx, params) {
        ctx.guest.balance += params.amount;
        return { result: { params, balance_after: ctx.guest.balance }, externalRef: ctx.store.nextId('acc') };
      },
    }),
    defineAction({
      name: 'issue_coupon',
      title: l({ en: 'Issue a promo coupon', ru: 'Выдать купон по акции' }),
      description: l({
        en: 'Issue a coupon for a coupon promo (type coupon_for_*) if the promo fired but there is no coupon, or did not fire because of a failure although the conditions were met. Do not propose if the receipt was paid with a coupon or the promo conditions are not met. The coupon type comes from the promo.',
        ru: 'Выдать купон по купонной акции (тип coupon_for_*), если акция сработала, а купона нет, или не сработала из-за сбоя при выполненных условиях. Не предлагай, если чек оплачен купоном или условия акции не выполнены. Тип купона берётся из акции.',
      }),
      input: z.object({
        promo_id: z.string().min(1),
        quantity: z.number().int().min(1).default(1),
        transaction_id: z
          .string()
          .min(1)
          .nullable()
          .default(null)
          .describe(l({ en: 'The receipt the coupon is due for', ru: 'Чек, за который положен купон' })),
      }),
      examples: [{ title: l({ en: 'A coupon for a receipt from 690 ₽', ru: 'Купон за чек от 690 ₽' }), params: { promo_id: 'dessert_for_total', quantity: 1, transaction_id: null } }],
      validate(ctx, params) {
        const check = new Check({ ...params });
        const { store, guest } = ctx;
        const promo = store.promos.get(params.promo_id);
        if (!promo) check.error(l({ en: `No promo ${params.promo_id}`, ru: `Акции ${params.promo_id} нет` }), 'promo_id');
        else if (!promo.type.startsWith('coupon_') || !promo.coupon_type) check.error(l({ en: `The promo "${promo.name}" does not issue coupons`, ru: `Акция «${promo.name}» не выдаёт купонов` }), 'promo_id');
        if (params.quantity > store.base.limits.max_coupons) check.error(l({ en: `At most ${store.base.limits.max_coupons} coupons at a time`, ru: `Не больше ${store.base.limits.max_coupons} купонов за раз` }), 'quantity');
        const tx = ownTransaction(ctx, params.transaction_id, check, l);
        if (tx && promo) {
          if (tx.paidWithCoupon) check.error(l({ en: 'The receipt was paid with a coupon — promos do not apply to it', ru: 'Чек оплачен купоном — акции на него не действуют' }), 'transaction_id');
          if (tx.at < store.time(promo.active_from) || tx.at > store.time(`${promo.active_to} 23:59:59`)) check.error(l({ en: 'The receipt is outside the promo period', ru: 'Чек вне периода акции' }), 'transaction_id');
          if (!tx.journal.some((j) => j.promoId === promo.id))
            check.warn(l({ en: 'The journal has no entry for the promo on this receipt — check the conditions', ru: 'В журнале нет записи по акции для этого чека — проверьте условия' }));
        }
        if (promo?.coupon_type) {
          const since = tx?.at ?? store.time(promo.active_from);
          const existing = store.couponsOf(guest.id).find((c) => c.typeId === promo.coupon_type && c.createdAt >= since);
          if (existing) {
            const name = store.couponTypes.get(existing.typeId)?.name;
            const at = formatLocal(existing.createdAt, store.base.timezone);
            check.warn(l({ en: `The guest already has a "${name}" coupon of ${at}`, ru: `У гостя уже есть купон «${name}» от ${at}` }));
          }
        }
        if (executed(ctx, 'issue_coupon').some((p) => p.promo_id === params.promo_id && p.transaction_id === params.transaction_id)) {
          check.error(l({ en: 'Support already issued a coupon for this promo and receipt', ru: 'Поддержка уже выдавала купон по этой акции за этот чек' }));
        }
        const type = promo?.coupon_type ? store.couponTypes.get(promo.coupon_type)?.name : null;
        const promoName = promo?.name ?? params.promo_id;
        return check.done(
          l({
            en: `Issue ${params.quantity} × "${type ?? '?'}" for the promo "${promoName}" — ${guest.name}`,
            ru: `Выдать ${params.quantity} × «${type ?? '?'}» по акции «${promoName}» — ${guest.name}`,
          }),
        );
      },
      execute(ctx, params) {
        const { store, guest } = ctx;
        const promo = store.promos.get(params.promo_id)!;
        const type = store.couponTypes.get(promo.coupon_type!)!;
        const coupons = Array.from({ length: params.quantity }, () => {
          const id = store.nextId('cpn');
          const coupon = {
            id,
            number: `SIM${id.replace(/\D/g, '').padStart(6, '0')}`,
            guestId: guest.id,
            typeId: type.id,
            createdAt: store.now,
            activeBefore: new Date(store.now.getTime() + type.days * 86_400_000),
            usedAt: null,
            source: 'support' as const,
            promoId: promo.id,
          };
          store.coupons.set(id, coupon);
          return { id, number: coupon.number, active_before: formatLocal(coupon.activeBefore, store.base.timezone) };
        });
        return { result: { params, coupons }, externalRef: coupons.map((c) => c.id).join(',') };
      },
    }),
    defineAction({
      name: 'accrue_cups',
      title: l({ en: 'Credit cups', ru: 'Засчитать кружки' }),
      description: l({
        en: [
          'Credit cups to the "6th cup free". basis:',
          "- receipt_not_on_card — a receipt with drinks was not registered on the card, cups in the guest's words; count — the number of drinks, at most 3; transaction_id = null;",
          '- drinks_not_counted — the receipt is on the card, but paid drinks were not counted (uncounted_drinks > 0 in get_receipt); count = uncounted_drinks, at most 3;',
          '- coupon_not_issued — cups were written off, but there is no free drink coupon; count is always 5.',
          'Do not propose: the receipt was paid with a coupon or a deposit, everything is already counted, 5 cups are collected and the coupon simply has not been claimed in the app.',
        ].join('\n'),
        ru: [
          'Засчитать кружки в «6-ю кружку в подарок». basis:',
          '- receipt_not_on_card — чек с напитками не провели по карте, кружки со слов гостя; count — число напитков, не больше 3; transaction_id = null;',
          '- drinks_not_counted — чек по карте есть, но оплаченные напитки не засчитались (uncounted_drinks > 0 в get_receipt); count = uncounted_drinks, не больше 3;',
          '- coupon_not_issued — кружки списались, а купона на подарочный напиток нет; count всегда 5.',
          'Не предлагай: чек оплачен купоном или депозитом, всё уже засчитано, накоплено 5 кружек и купон просто не забран в приложении.',
        ].join('\n'),
      }),
      input: z.object({
        basis: z.enum(['receipt_not_on_card', 'drinks_not_counted', 'coupon_not_issued']),
        count: z.number().int().min(1).max(10),
        transaction_id: z.string().min(1).nullable().default(null),
      }),
      examples: [{ title: l({ en: 'A drink not on the card', ru: 'Напиток не по карте' }), params: { basis: 'receipt_not_on_card', count: 1, transaction_id: null } }],
      validate(ctx, params) {
        const check = new Check({ ...params });
        const { store, guest } = ctx;
        const rules = store.base.cups;
        if (store.now < store.time(rules.period_from) || store.now >= store.time(rules.period_to)) check.error(l({ en: 'The "6th cup" promo is not active now', ru: 'Акция «6-я кружка» сейчас не действует' }));
        const tx = ownTransaction(ctx, params.transaction_id, check, l);
        const max = store.base.limits.max_cups;

        if (params.basis === 'receipt_not_on_card') {
          if (params.count > max) check.error(l({ en: `At most ${max} cups at a time`, ru: `Не больше ${max} кружек за раз` }), 'count');
          if (tx) check.warn(l({ en: 'The receipt is on the card — its basis is drinks_not_counted', ru: 'Чек есть по карте — для него основание drinks_not_counted' }));
        }
        if (params.basis === 'drinks_not_counted') {
          if (params.transaction_id === null) check.error(l({ en: 'A receipt whose drinks were not counted is required', ru: 'Нужен чек, напитки из которого не засчитались' }), 'transaction_id');
          else if (tx) {
            const reasons = {
              coupon: { en: 'paid with a coupon', ru: 'оплачен купоном' },
              deposit: { en: 'paid with a deposit', ru: 'оплачен депозитом' },
              out_of_period: { en: 'outside the promo period', ru: 'вне периода акции' },
            } as const;
            const uncounted = Math.max(0, tx.drinks - tx.cupsCounted);
            if (tx.cupsExcluded) {
              const reason = l(reasons[tx.cupsExcluded]);
              check.error(l({ en: `The receipt does not take part in the promo: ${reason}`, ru: `Чек не участвует в акции: ${reason}` }), 'transaction_id');
            }
            else if (uncounted === 0) check.error(l({ en: 'All paid drinks of the receipt are already counted', ru: 'Все оплаченные напитки чека уже засчитаны' }), 'transaction_id');
            else if (params.count > uncounted) {
              check.warn(l({ en: `${uncounted} not counted on the receipt, not ${params.count}`, ru: `В чеке не засчитано ${uncounted}, а не ${params.count}` }));
              check.normalized.count = uncounted;
            }
            if (check.normalized.count > max) check.error(l({ en: `At most ${max} cups at a time`, ru: `Не больше ${max} кружек за раз` }), 'count');
          }
        }
        if (params.basis === 'coupon_not_issued') {
          if (params.count !== rules.cups_for_coupon) {
            check.warn(l({ en: `A coupon that never appeared returns ${rules.cups_for_coupon} cups`, ru: `За непоявившийся купон возвращается ${rules.cups_for_coupon} кружек` }));
            check.normalized.count = rules.cups_for_coupon;
          }
          const lastWriteoff = store.cupsLedger(guest.id).filter((e) => e.reason === 'writeoff').at(-1);
          const couponAfter = lastWriteoff && store.couponsOf(guest.id).some((c) => c.typeId === rules.coupon_type && c.createdAt >= lastWriteoff.at);
          if (!lastWriteoff) check.error(l({ en: "The guest's cups were never written off", ru: 'Кружки у гостя не списывались' }));
          else if (couponAfter) check.error(l({ en: 'A free drink coupon was issued after the cups were written off', ru: 'После списания кружек купон на подарочный напиток выдан' }));
        }
        if (params.transaction_id !== null && executed(ctx, 'accrue_cups').some((p) => p.basis === params.basis && p.transaction_id === params.transaction_id)) {
          check.error(l({ en: 'Support already credited cups for this receipt', ru: 'По этому чеку поддержка уже засчитывала кружки' }));
        }
        const count = check.normalized.count;
        const where = tx ? ` (${receiptLabel(store, tx)})` : '';
        return check.done(l({ en: `Credit ${count} ${cupsWord(count)}${where} — ${guest.name}`, ru: `Засчитать ${count} ${cupsWord(count)}${where} — ${guest.name}` }));
      },
      execute(ctx, params) {
        const { store, guest } = ctx;
        store.cups.push({ guestId: guest.id, at: store.now, delta: params.count, reason: 'manual', transactionId: params.transaction_id });
        return { result: { params, active_cups: store.activeCups(guest.id) }, externalRef: store.nextId('cups') };
      },
    }),
    defineAction({
      name: 'refund_order',
      title: l({ en: 'Refund an order', ru: 'Вернуть деньги за заказ' }),
      description: l({
        en: 'Refund a paid pickup order the guest did not receive (the coffee shop did not hand it over, cancelled it after payment). A handed-over order — only by the operator\'s decision.',
        ru: 'Вернуть деньги за оплаченный заказ самовывоза, который гость не получил (кофейня не выдала, отменила после оплаты). Выданный заказ — только по решению оператора.',
      }),
      input: z.object({
        order_id: z.string().min(1),
        reason: z.string().trim().min(3).max(500),
      }),
      examples: [],
      validate(ctx, params) {
        const check = new Check({ ...params });
        const { store, guest } = ctx;
        const order = store.orders.get(params.order_id);
        if (!order || order.guestId !== guest.id || order.createdAt > store.now) {
          check.error(l({ en: `Order ${params.order_id} not found for this guest`, ru: `Заказ ${params.order_id} не найден у этого гостя` }), 'order_id');
          return check.done();
        }
        if (order.status === 'refunded') check.error(l({ en: 'The order is already refunded', ru: 'Деньги за заказ уже возвращены' }), 'order_id');
        else if (!order.paidAt) check.error(l({ en: 'The order is not paid', ru: 'Заказ не оплачен' }), 'order_id');
        else if (order.status === 'completed') check.warn(l({ en: "The order was handed over to the guest — a refund only by the operator's decision", ru: 'Заказ выдан гостю — возврат только по решению оператора' }));
        const place = store.places.get(order.placeId)?.name ?? order.placeId;
        return check.done(
          l({
            en: `Refund ${order.total} ₽ for order #${order.number} (${place}) — ${guest.name}`,
            ru: `Вернуть ${order.total} ₽ за заказ №${order.number} (${place}) — ${guest.name}`,
          }),
        );
      },
      execute(ctx, params) {
        const order = ctx.store.orders.get(params.order_id)!;
        order.status = 'refunded';
        order.refundedAt = ctx.store.now;
        return { result: { params, amount: order.total, payment_method: order.payment_method }, externalRef: ctx.store.nextId('rfd') };
      },
    }),
  ];
}
