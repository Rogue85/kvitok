import type { ExecuteResponse } from '@kvitok/protocol';
import type { z } from 'zod';
import { parseLocal, type BaseWorld, type OrderSchema, type PromoSchema, type ReceiptItemSchema, type Scenario } from './world.js';

export interface Guest {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  cardNumber: string;
  cashbackPercent: number;
  balance: number;
  registeredAt: Date;
  city: string;
}

export type CupsExclusion = 'coupon' | 'deposit' | 'out_of_period';

export interface Transaction {
  id: string;
  guestId: string;
  at: Date;
  placeId: string;
  receiptNumber: string;
  total: number;
  balanceAdd: number;
  balanceWriteoff: number;
  paidWithCoupon: string | null;
  paidWithDeposit: boolean;
  items: Array<z.infer<typeof ReceiptItemSchema>>;
  /** Paid drinks under the "6th cup" rules. */
  drinks: number;
  cupsCounted: number;
  cupsExcluded: CupsExclusion | null;
  journal: Array<{ promoId: string; lines: string[]; applied: boolean }>;
}

export interface Coupon {
  id: string;
  number: string;
  guestId: string;
  typeId: string;
  createdAt: Date;
  activeBefore: Date;
  usedAt: Date | null;
  source: 'promo' | 'cups' | 'support' | 'birthday';
  promoId: string | null;
}

export interface CupsEntry {
  guestId: string;
  at: Date;
  delta: number;
  reason: 'purchase' | 'opening' | 'writeoff' | 'manual';
  transactionId: string | null;
}

export type Order = Omit<z.infer<typeof OrderSchema>, 'guest' | 'place' | 'created_at' | 'paid_at' | 'ready_at' | 'issued_at' | 'refunded_at'> & {
  guestId: string;
  placeId: string;
  createdAt: Date;
  paidAt: Date | null;
  readyAt: Date | null;
  issuedAt: Date | null;
  refundedAt: Date | null;
};

export type Promo = z.infer<typeof PromoSchema>;

/** An executed action: the response is stored by Idempotency-Key. */
export interface Execution {
  key: string;
  action: string;
  customerRef: string;
  /** Fingerprint of the request parameters — the same key with other parameters gives 409. */
  paramsHash: string;
  params: Record<string, unknown>;
  response: ExecuteResponse;
  at: Date;
}

export class WorldError extends Error {
  constructor(readonly problems: string[]) {
    super(`The simulator world does not build:\n- ${problems.join('\n- ')}`);
  }
}

/** The world state in memory. Reference data never changes; only actions change guest data. */
export class SimStore {
  readonly now: Date;
  readonly guests = new Map<string, Guest>();
  readonly transactions = new Map<string, Transaction>();
  readonly coupons = new Map<string, Coupon>();
  readonly orders = new Map<string, Order>();
  readonly cups: CupsEntry[] = [];
  readonly executions = new Map<string, Execution>();
  readonly places: Map<string, BaseWorld['places'][number]>;
  readonly promos: Map<string, Promo>;
  readonly couponTypes: Map<string, BaseWorld['coupon_types'][number]>;
  private sequence = 0;

  constructor(
    readonly base: BaseWorld,
    readonly scenarios: Scenario[],
  ) {
    this.now = this.time(base.now);
    this.places = new Map(base.places.map((p) => [p.id, p]));
    this.promos = new Map(base.promos.map((p) => [p.id, p]));
    this.couponTypes = new Map(base.coupon_types.map((c) => [c.id, c]));
    this.load();
  }

  time(local: string): Date {
    return parseLocal(local, this.base.timezone);
  }

  nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${String(this.sequence).padStart(4, '0')}`;
  }

  /* ───────────── reading ───────────── */

  /** Guests by identity: a phone without formatting, a case-insensitive email, a card number. */
  findGuests(type: string, value: string): Guest[] {
    const all = [...this.guests.values()];
    if (type === 'phone') {
      const digits = value.replace(/\D+/g, '').replace(/^8(?=\d{10}$)/, '7');
      return all.filter((g) => g.phone === digits);
    }
    if (type === 'email') {
      return all.filter((g) => g.email !== null && g.email === value.trim().toLowerCase());
    }
    if (type === 'card_number') {
      return all.filter((g) => g.cardNumber === value.trim());
    }
    return [];
  }

  transactionsOf(guestId: string): Transaction[] {
    return [...this.transactions.values()].filter((t) => t.guestId === guestId && t.at <= this.now).sort((a, b) => b.at.getTime() - a.at.getTime());
  }

  couponsOf(guestId: string): Coupon[] {
    return [...this.coupons.values()].filter((c) => c.guestId === guestId && c.createdAt <= this.now).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  ordersOf(guestId: string): Order[] {
    return [...this.orders.values()].filter((o) => o.guestId === guestId && o.createdAt <= this.now).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  couponStatus(coupon: Coupon): 'active' | 'used' | 'expired' {
    if (coupon.usedAt) return 'used';
    return coupon.activeBefore < this.now ? 'expired' : 'active';
  }

  cupsLedger(guestId: string): CupsEntry[] {
    return this.cups.filter((e) => e.guestId === guestId && e.at <= this.now).sort((a, b) => a.at.getTime() - b.at.getTime());
  }

  activeCups(guestId: string): number {
    return Math.max(0, this.cupsLedger(guestId).reduce((sum, e) => sum + e.delta, 0));
  }

  promosActiveAt(date: Date): Promo[] {
    return [...this.promos.values()].filter((p) => this.time(p.active_from) <= date && date < this.time(`${p.active_to} 23:59:59`));
  }

  /* ───────────── loading the world ───────────── */

  private load(): void {
    const problems: string[] = [];
    const unique = (kind: string, map: Map<string, unknown>, id: string, owner: string) => {
      if (map.has(id)) problems.push(`${owner}: ${kind} ${id} already exists in another scenario`);
    };
    const exists = (kind: string, map: Map<string, unknown>, id: string | undefined, owner: string) => {
      if (id !== undefined && !map.has(id)) problems.push(`${owner}: no ${kind} ${id}`);
    };
    const phones = new Map<string, string>();
    const rules = this.base.cups;
    const period = { from: this.time(rules.period_from), to: this.time(rules.period_to) };

    for (const scenario of this.scenarios) {
      const owner = `scenario ${scenario.id}`;
      for (const g of scenario.guests) {
        unique('guest', this.guests, g.id, owner);
        if (phones.has(g.phone)) problems.push(`${owner}: phone ${g.phone} already belongs to guest ${phones.get(g.phone)}`);
        phones.set(g.phone, g.id);
        this.guests.set(g.id, {
          id: g.id,
          name: g.name,
          phone: g.phone,
          email: g.email?.toLowerCase() ?? null,
          cardNumber: g.card_number ?? `70${g.phone.slice(-7)}`,
          cashbackPercent: g.cashback_percent,
          balance: g.balance,
          registeredAt: this.time(g.registered_at),
          city: g.city ?? this.base.guest_city,
        });
      }
    }

    for (const scenario of this.scenarios) {
      const owner = `scenario ${scenario.id}`;
      for (const t of scenario.transactions) {
        unique('receipt', this.transactions, t.id, owner);
        exists('guest', this.guests, t.guest, owner);
        exists('coffee shop', this.places, t.place, owner);
        t.promo_journal.forEach((j) => exists('promo', this.promos, j.promo, owner));
        const guest = this.guests.get(t.guest);
        const at = this.time(t.at);
        const drinks = t.items.filter((i) => i.price > 0 && rules.drink_groups.includes(i.group)).reduce((sum, i) => sum + i.amount, 0);
        const excluded: CupsExclusion | null = t.paid_with_coupon ? 'coupon' : t.paid_with_deposit ? 'deposit' : at < period.from || at >= period.to ? 'out_of_period' : null;
        const transaction: Transaction = {
          id: t.id,
          guestId: t.guest,
          at,
          placeId: t.place,
          receiptNumber: t.receipt_number ?? String(4000 + this.transactions.size * 7),
          total: t.total,
          balanceAdd: t.balance_add ?? Math.floor((t.total * (guest?.cashbackPercent ?? 0)) / 100),
          balanceWriteoff: t.balance_writeoff,
          paidWithCoupon: t.paid_with_coupon ?? null,
          paidWithDeposit: t.paid_with_deposit,
          items: t.items,
          drinks,
          cupsCounted: t.cups_counted ?? (excluded ? 0 : drinks),
          cupsExcluded: excluded,
          journal: t.promo_journal.map((j) => ({ promoId: j.promo, lines: j.lines, applied: j.applied })),
        };
        this.transactions.set(t.id, transaction);
        if (transaction.cupsCounted > 0) {
          this.cups.push({ guestId: t.guest, at, delta: transaction.cupsCounted, reason: 'purchase', transactionId: t.id });
        }
      }
      for (const c of scenario.coupons) {
        unique('coupon', this.coupons, c.id, owner);
        exists('guest', this.guests, c.guest, owner);
        exists('coupon type', this.couponTypes, c.type, owner);
        exists('promo', this.promos, c.promo, owner);
        const createdAt = this.time(c.created_at);
        const days = this.couponTypes.get(c.type)?.days ?? 30;
        this.coupons.set(c.id, {
          id: c.id,
          number: `SIM${String(this.coupons.size + 1).padStart(6, '0')}`,
          guestId: c.guest,
          typeId: c.type,
          createdAt,
          activeBefore: c.active_before ? this.time(c.active_before) : new Date(createdAt.getTime() + days * 86_400_000),
          usedAt: c.used_at ? this.time(c.used_at) : null,
          source: c.source,
          promoId: c.promo ?? null,
        });
      }
      for (const e of scenario.cups) {
        exists('guest', this.guests, e.guest, owner);
        this.cups.push({ guestId: e.guest, at: this.time(e.at), delta: e.delta, reason: e.reason, transactionId: null });
      }
      for (const o of scenario.orders) {
        unique('order', this.orders, o.id, owner);
        exists('guest', this.guests, o.guest, owner);
        exists('coffee shop', this.places, o.place, owner);
        const { guest, place, created_at, paid_at, ready_at, issued_at, refunded_at, ...rest } = o;
        this.orders.set(o.id, {
          ...rest,
          guestId: guest,
          placeId: place,
          createdAt: this.time(created_at),
          paidAt: paid_at ? this.time(paid_at) : null,
          readyAt: ready_at ? this.time(ready_at) : null,
          issuedAt: issued_at ? this.time(issued_at) : null,
          refundedAt: refunded_at ? this.time(refunded_at) : null,
        });
      }
      if (scenario.ticket.customer) exists('guest', this.guests, scenario.ticket.customer, owner);
      if (this.time(scenario.ticket.sent_at) > this.now) problems.push(`${owner}: the ticket is sent after the world's "now" (${this.base.now})`);
    }
    for (const promo of this.promos.values()) {
      exists('coupon type', this.couponTypes, promo.coupon_type, `promo ${promo.id}`);
      promo.places.forEach((p) => exists('coffee shop', this.places, p, `promo ${promo.id}`));
    }
    exists('coupon type', this.couponTypes, rules.coupon_type, 'cups rules');

    if (problems.length > 0) {
      throw new WorldError(problems);
    }
  }
}
