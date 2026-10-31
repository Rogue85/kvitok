---
key: pickup_order
title: A problem with a pickup order
when: The guest paid for an order in the app but did not receive it, the coffee shop was closed, the order was cancelled after payment, asks for a refund for the order.
suggested_department: stores
tools: [get_orders]
actions: [refund_order]
---
1. Find the order in `get_orders` by time, coffee shop and total.
2. The order is paid (`paid_at` is set) but not handed over (`status` — paid, preparing, ready or cancelled) — propose `refund_order` with a reason.
3. The order was handed over (`completed`) — a refund only by the operator's decision: describe the situation, propose the action only if the guest explicitly reports a defect, and say so in the reason.
4. Already `refunded` — tell the guest the money was returned, and when.
