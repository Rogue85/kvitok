---
key: points_not_accrued
title: Не начислены баллы за покупку
when: Гость пишет, что за покупку не пришли баллы или кэшбек, приложение не сработало при оплате, просит «зачислить по чеку».
suggested_department: loyalty
tools: [get_transactions, get_receipt]
actions: [accrue_points]
---
1. Найди покупку из обращения в `get_transactions` по дате, времени и сумме.
2. Чек есть и `balance_add` больше 0 — баллы уже начислены; ответь гостю, когда и сколько, действие не предлагай.
3. Чек есть, а `balance_add` = 0 — предложи `accrue_points` с `basis: base_cashback`, `transaction_id` этого чека и amount = floor(сумма × cashback_percent / 100).
4. Чека нет — его не провели по карте. Если гость назвал сумму, предложи `base_cashback` с `transaction_id: null` и `receipt_total` из обращения. Суммы нет — не предлагай действие, попроси оператора уточнить её у гостя.
5. Про акции не пиши, если гость о них не спрашивал.
