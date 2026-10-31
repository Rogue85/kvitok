---
key: promo_issues
title: Акция не сработала или купон по акции не пришёл
when: Гость пишет про повышенный или двойной кэшбек по акции, купон за покупку, «акция не применилась».
suggested_department: loyalty
tools: [get_transactions, get_promos, get_promo_journal, get_coupons, get_receipt]
actions: [accrue_points, issue_coupon]
---
1. Найди чек и посмотри акции на его дату (`get_promos`), затем журнал по чеку (`get_promo_journal`).
2. Чек оплачен купоном — акции не действуют, действие не предлагай.
3. Кэшбек по акции: журнал даёт «Total cashback: N», а баллы по чеку не пришли — `accrue_points` с `basis: promo_cashback`, `promo_id` и amount = N. Числа в журнале нет — напиши оператору, что нужен ручной расчёт.
4. Купонная акция: applied и «Coupons» больше 0, а в `get_coupons` нет купона этого типа после чека — `issue_coupon` с `promo_id` и `transaction_id`.
5. Записи по акции нет или «not found», «discount», сумма меньше порога — условия не выполнены, объясни оператору почему, действие не предлагай.
