import { describe, expect, it } from 'vitest';
import { simActions } from './actions.js';
import { loadWorld } from './scenarios.js';
import { SimStore } from './store.js';

// The messages are checked in Russian; the English texts are a translation of the same checks.
const ACTIONS = simActions('ru');

function setup() {
  const world = loadWorld({ locale: 'ru' });
  const store = new SimStore(world.base, world.scenarios);
  const run = (name: string, guestId: string, params: Record<string, unknown>) => {
    const action = ACTIONS.find((a) => a.name === name)!;
    const guest = store.guests.get(guestId)!;
    return action.validate({ store, guest }, action.input.parse(params));
  };
  /** Execution as in the server: the result goes to the journal, which catches repeats. */
  const execute = (name: string, guestId: string, params: Record<string, unknown>) => {
    const action = ACTIONS.find((a) => a.name === name)!;
    const guest = store.guests.get(guestId)!;
    const outcome = action.validate({ store, guest }, action.input.parse(params));
    const { result, externalRef } = action.execute({ store, guest }, outcome.normalized);
    store.executions.set(externalRef, {
      key: externalRef, action: name, customerRef: guestId, paramsHash: '', params, at: store.now,
      response: { status: 'executed', result, external_ref: externalRef },
    });
    return result;
  };
  return { store, run, execute };
}

describe('accrue_points', () => {
  it('an amount off the tier — a warning and normalization', () => {
    const { run } = setup();
    const outcome = run('accrue_points', 'anna', { basis: 'base_cashback', amount: 38, transaction_id: null, receipt_total: 380 });
    expect(outcome).toMatchObject({ ok: true, normalized: { amount: 19 } });
    expect(outcome.warnings[0]).toMatch(/положено 19/);
    expect(outcome.preview).toMatch(/Начислить 19 баллов/);
  });

  it('points already credited for the receipt, another guest\'s receipt, no amount without a receipt — errors', () => {
    const { run } = setup();
    expect(run('accrue_points', 'vera', { basis: 'base_cashback', amount: 26, transaction_id: 'vera-t1' }).errors[0]!.message).toMatch(/уже начислены: 26/);
    expect(run('accrue_points', 'anna', { basis: 'base_cashback', amount: 26, transaction_id: 'vera-t1' }).errors[0]!.message).toMatch(/не найден у этого гостя/);
    expect(run('accrue_points', 'anna', { basis: 'base_cashback', amount: 19, transaction_id: null }).ok).toBe(false);
  });

  it('a write-off refund is at most the written-off amount; points limit', () => {
    const { run } = setup();
    expect(run('accrue_points', 'gleb', { basis: 'writeoff_refund', amount: 200, transaction_id: 'gleb-t1' }).errors[0]!.message).toMatch(/списано 120/);
    expect(run('accrue_points', 'gleb', { basis: 'writeoff_refund', amount: 1500, transaction_id: 'gleb-t1' }).errors.map((e) => e.message).join()).toMatch(/лимита 1000/);
  });

  it('a repeat for the same receipt after execution — an error; the balance grew once', () => {
    const { run, execute, store } = setup();
    execute('accrue_points', 'boris', { basis: 'base_cashback', amount: 44, transaction_id: 'boris-t1' });
    expect(store.guests.get('boris')!.balance).toBe(1254);
    expect(run('accrue_points', 'boris', { basis: 'base_cashback', amount: 44, transaction_id: 'boris-t1' }).errors.map((e) => e.message).join()).toMatch(/уже начисляла/);
  });
});

describe('issue_coupon', () => {
  it('a receipt paid with a coupon — an error; a non-coupon promo — an error', () => {
    const { run } = setup();
    expect(run('issue_coupon', 'zhanna', { promo_id: 'dessert_for_total', transaction_id: 'zhanna-t1' }).errors[0]!.message).toMatch(/оплачен купоном/);
    expect(run('issue_coupon', 'egor', { promo_id: 'autumn_double_cashback', transaction_id: 'egor-t1' }).errors[0]!.message).toMatch(/не выдаёт купонов/);
  });

  it('execution creates a coupon, the second time — a coupon warning and a repeat error', () => {
    const { run, execute, store } = setup();
    const result = execute('issue_coupon', 'egor', { promo_id: 'dessert_for_total', transaction_id: 'egor-t1' }) as { coupons: Array<{ active_before: string }> };
    expect(result.coupons[0]!.active_before).toBe('2026-10-29 12:00');
    expect(store.couponsOf('egor')).toHaveLength(1);
    const again = run('issue_coupon', 'egor', { promo_id: 'dessert_for_total', transaction_id: 'egor-t1' });
    expect(again.warnings.join()).toMatch(/уже есть купон/);
    expect(again.ok).toBe(false);
  });
});

describe('accrue_cups', () => {
  it('the receipt does not count (paid with a coupon) and everything is counted — errors', () => {
    const { run } = setup();
    expect(run('accrue_cups', 'zhanna', { basis: 'drinks_not_counted', count: 1, transaction_id: 'zhanna-t1' }).errors[0]!.message).toMatch(/оплачен купоном/);
    expect(run('accrue_cups', 'kira', { basis: 'drinks_not_counted', count: 1, transaction_id: 'kira-t1' }).errors[0]!.message).toMatch(/уже засчитаны/);
  });

  it('a missing coupon always gives 5; if a coupon exists after the write-off — an error', () => {
    const { run, execute, store } = setup();
    expect(run('accrue_cups', 'ivan', { basis: 'coupon_not_issued', count: 3 })).toMatchObject({ ok: true, normalized: { count: 5 } });
    expect(run('accrue_cups', 'kira', { basis: 'coupon_not_issued', count: 5 }).errors[0]!.message).toMatch(/не списывались/);
    execute('accrue_cups', 'zoya', { basis: 'drinks_not_counted', count: 2, transaction_id: 'zoya-t1' });
    expect(store.activeCups('zoya')).toBe(4);
  });
});

describe('refund_order', () => {
  it('a paid but not handed-over order — a refund; a repeat — an error', () => {
    const { run, execute, store } = setup();
    expect(run('refund_order', 'nikita', { order_id: 'nikita-o1', reason: 'кофейня закрыта' })).toMatchObject({ ok: true, preview: expect.stringMatching(/Вернуть 610 ₽ за заказ №1043/) });
    execute('refund_order', 'nikita', { order_id: 'nikita-o1', reason: 'кофейня закрыта' });
    expect(store.orders.get('nikita-o1')!.status).toBe('refunded');
    expect(run('refund_order', 'nikita', { order_id: 'nikita-o1', reason: 'кофейня закрыта' }).errors[0]!.message).toMatch(/уже возвращены/);
    expect(run('refund_order', 'anna', { order_id: 'nikita-o1', reason: 'чужой' }).errors[0]!.message).toMatch(/не найден/);
  });
});

describe('English texts', () => {
  it('previews and errors come in the simulator language', () => {
    const world = loadWorld({ locale: 'en' });
    const store = new SimStore(world.base, world.scenarios);
    const action = simActions('en').find((a) => a.name === 'accrue_points')!;
    const anna = store.guests.get('anna')!;
    const outcome = action.validate({ store, guest: anna }, action.input.parse({ basis: 'base_cashback', amount: 38, transaction_id: null, receipt_total: 380 }));
    expect(outcome.preview).toBe('Credit 19 points (tier cashback, a 380 ₽ receipt not on the card) — Anna');
    expect(outcome.warnings[0]).toMatch(/gives 19, not 38/);
    expect(action.validate({ store, guest: anna }, action.input.parse({ basis: 'base_cashback', amount: 26, transaction_id: 'vera-t1' })).errors[0]!.message).toMatch(/not found for this guest/);
  });
});
