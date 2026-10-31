---
key: points_writeoff_refund
title: Points were written off but did not go towards the payment
when: The guest writes that points were written off but they paid the full amount in money, or the payment with points failed.
suggested_department: loyalty
tools: [get_transactions]
actions: [accrue_points]
---
1. Find the receipt in `get_transactions` and look at its items in `get_receipt`.
2. How many points did go towards the payment: the sum of the items (price × quantity) minus the receipt total (`total`). Return only what was not applied: amount = `balance_writeoff` − what went towards the payment.
   - Example: 150 written off, items for 500 ₽, total 450 ₽ → 50 went towards the payment → return 100.
   - If the guest says how much was applied (a 50 ₽ discount), trust their words; if they write that nothing was applied, return everything written off.
   Propose `accrue_points` with `basis: writeoff_refund` and this amount, show the calculation in calculation.
3. If the points for the purchase did not arrive for the same receipt either (`balance_add` = 0), propose `base_cashback` separately.
4. `balance_writeoff` = 0 or no receipt on the card — do not propose an action, tell the operator no write-off is visible on the card.
