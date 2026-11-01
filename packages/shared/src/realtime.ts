export type RealtimeEvent =
  | { type: 'ticket.created'; ticketId: string }
  | { type: 'ticket.updated'; ticketId: string }
  | { type: 'message.created'; ticketId: string; messageId: string }
  | { type: 'delivery.updated'; ticketId: string; messageId: string | null; deliveryId: string; status: string }
  | { type: 'agent.updated'; ticketId: string; state: string }
  /** The ticket changed department: sent to those who see the old one or the new one. */
  | { type: 'ticket.moved'; ticketId: string; from: string | null; to: string | null }
  /** The user's role or departments changed: their open streams and pages reload access. */
  | { type: 'access.changed'; userId: string };
