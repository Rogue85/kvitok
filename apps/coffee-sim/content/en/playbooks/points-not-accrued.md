---
key: points_not_accrued
title: Points not credited for a purchase
when: The guest writes that the points or cashback for a purchase did not arrive, the app did not work at payment, asks to "credit by the receipt".
suggested_department: loyalty
tools: [get_transactions, get_receipt]
actions: [accrue_points]
---
1. Find the purchase from the ticket in `get_transactions` by date, time and total.
2. The receipt exists and `balance_add` is above 0 — the points are already credited; tell the guest when and how many, do not propose an action.
3. The receipt exists, but `balance_add` = 0 — propose `accrue_points` with `basis: base_cashback`, the `transaction_id` of this receipt and amount = floor(total × cashback_percent / 100).
4. No receipt — it was not registered on the card. If the guest named the amount, propose `base_cashback` with `transaction_id: null` and `receipt_total` from the ticket. No amount — do not propose an action, ask the operator to clarify it with the guest.
5. Do not write about promos unless the guest asked about them.
