---
key: cups_6th_free
title: «6-я кружка в подарок»
when: Гость пишет про кружки, 6-й кофе в подарок, не засчитался напиток, не пришёл купон на бесплатный кофе.
suggested_department: loyalty
tools: [get_cups_progress, get_transactions, get_receipt]
actions: [accrue_cups]
---
1. Посмотри `get_cups_progress` и чек из обращения (`get_transactions`, затем `get_receipt`).
2. Чек есть, `excluded` пусто, `uncounted_drinks` больше 0 — `accrue_cups` с `basis: drinks_not_counted`, count = uncounted_drinks (не больше 3).
3. Чека с напитками нет по карте — `basis: receipt_not_on_card`, count — число напитков со слов гостя (не больше 3). Гость не назвал число — попроси оператора уточнить.
4. Кружки списались (`last_write_off_at`), а купона после списания нет — `basis: coupon_not_issued`, count = 5.
5. Не предлагай: чек оплачен купоном или депозитом (`excluded`), всё уже засчитано, подарочный напиток или не напиток. Если накоплено 5 кружек и купона нет — гость ещё не забрал его: подскажи в ответе, что купон забирается в приложении в разделе акции.
