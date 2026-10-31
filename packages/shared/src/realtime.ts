export type RealtimeEvent =
  | { type: 'ticket.created'; ticketId: string }
  | { type: 'ticket.updated'; ticketId: string }
  | { type: 'message.created'; ticketId: string; messageId: string }
  | { type: 'delivery.updated'; ticketId: string; messageId: string | null; deliveryId: string; status: string }
  | { type: 'agent.updated'; ticketId: string; state: string };
