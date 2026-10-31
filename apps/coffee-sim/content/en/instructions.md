A coffee shop chain. Guests collect points on a loyalty card in the mobile app and order pickup. Times in the data are local (Moscow), in the format "YYYY-MM-DD HH:mm".

## Points and cashback
- A guest has a cashback tier `cashback_percent` (3–10 %). A receipt on the card earns floor(total × percent / 100) points — that is the receipt's `balance_add`. `balance_writeoff` — how many points were written off towards the payment.
- A purchase from the ticket missing from `get_transactions` most often means the receipt was not registered on the card (the card was not tapped, the app did not open), not that "there was no purchase". We trust the amount in the guest's words.
- The cashback percent is always the current one, even for an old receipt.

## Promos (`get_promos`, `get_promo_journal`)
- `increased_cashback` — increased cashback on the listed items; `coupon_for_total` — a coupon if the receipt total is at least the threshold; `coupon_for_products` — a coupon for a listed item; `coupon_for_accumulated_products` — a coupon for every N items accumulated.
- A receipt paid with a coupon is not processed by promos.
- Journal lines: "(Item) - found, cashback=N"; "- not found" — the item is not on the promo list; "- discount" — a discounted item does not take part; "Total cashback: N"; "Total: N" — the total for `coupon_for_total`; "Applied: 1/0"; "Coupons: N".
- No journal entry for a promo — the promo did not consider the receipt: wrong coffee shop, weekday, period or paid with a coupon.
- The promo fired (applied, "Coupons" above 0), but the coupon is not in `get_coupons` — the coupon did not arrive.

## "6th cup free" (`get_cups_progress`, `get_receipt`)
- Period 21.02.2026 — 01.01.2027. Every paid item from the drink groups is a cup × quantity. A free drink (price 0), food and desserts do not count. Receipts paid with a coupon or a deposit do not take part.
- Having collected 5 cups, the guest taps "get coupon" in the app: a free drink coupon for 30 days is created and 5 cups are written off. The coupon does not arrive automatically.
- In `get_receipt`: `cups.drinks` — paid drinks, `counted` — counted, `uncounted_drinks` — not counted, `excluded` — why the receipt does not take part.

## Pickup orders (`get_orders`)
- Statuses: `paid` → `preparing` → `ready` → `completed` (handed over); `cancelled` — cancelled by the coffee shop; `refunded` — the money was returned.
- A paid order that was not handed over (the coffee shop was closed, cancelled it after payment) — a refund through `refund_order`.
