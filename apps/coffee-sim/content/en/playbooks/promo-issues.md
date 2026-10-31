---
key: promo_issues
title: A promo did not work or the promo coupon did not arrive
when: The guest writes about increased or double promo cashback, a coupon for a purchase, "the promo was not applied".
suggested_department: loyalty
tools: [get_transactions, get_promos, get_promo_journal, get_coupons, get_receipt]
actions: [accrue_points, issue_coupon]
---
1. Find the receipt and look at the promos on its date (`get_promos`), then the journal for the receipt (`get_promo_journal`).
2. The receipt was paid with a coupon — promos do not apply, do not propose an action.
3. Promo cashback: the journal gives "Total cashback: N", but the points for the receipt did not arrive — `accrue_points` with `basis: promo_cashback`, `promo_id` and amount = N. No number in the journal — tell the operator a manual calculation is needed.
4. A coupon promo: applied and "Coupons" above 0, but `get_coupons` has no coupon of this type after the receipt — `issue_coupon` with `promo_id` and `transaction_id`.
5. No entry for the promo, or "not found", "discount", a total below the threshold — the conditions are not met, explain to the operator why, do not propose an action.
