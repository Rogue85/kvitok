---
key: cups_6th_free
title: '"6th cup free"'
when: The guest writes about cups, the 6th coffee free, a drink not counted, the free coffee coupon not arriving.
suggested_department: loyalty
tools: [get_cups_progress, get_transactions, get_receipt]
actions: [accrue_cups]
---
1. Look at `get_cups_progress` and the receipt from the ticket (`get_transactions`, then `get_receipt`).
2. The receipt exists, `excluded` is empty, `uncounted_drinks` is above 0 — `accrue_cups` with `basis: drinks_not_counted`, count = uncounted_drinks (at most 3).
3. No receipt with drinks on the card — `basis: receipt_not_on_card`, count — the number of drinks in the guest's words (at most 3). The guest did not name the number — ask the operator to clarify.
4. Cups were written off (`last_write_off_at`), but there is no coupon after the write-off — `basis: coupon_not_issued`, count = 5.
5. Do not propose: the receipt was paid with a coupon or a deposit (`excluded`), everything is already counted, a free drink or not a drink. If 5 cups are collected and there is no coupon, the guest has not claimed it yet: tell them in the reply that the coupon is claimed in the app in the promo section.
