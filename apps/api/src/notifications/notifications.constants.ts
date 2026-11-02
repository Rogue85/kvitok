import type { NotificationKind } from './notification-rules';

export const NOTIFY_QUEUE = 'notifications';
export const NOTIFY_JOB = 'notify';

/** A new ticket or customer message waits for the agent's analysis at most this long. */
export const AGENT_WAIT_MS = 45_000;

export interface NotifyJobData {
  /** `ticket_created` and `customer_message` arrive as `incoming`: the kind per member is decided when it is sent. */
  kind: Exclude<NotificationKind, 'ticket_created' | 'customer_message'> | 'incoming';
  workspaceId: string;
  ticketId: string;
  /** The user whose action caused the event; they are not notified. */
  actorId?: string | null;
  /** `incoming`: the ticket was created by the first of the messages. */
  created?: boolean;
  /** `incoming`, `agent_needs_operator`: customer messages and agent output since this moment (ISO). */
  since?: string;
  /** `incoming`: the agent also asked the operator something during the wait. */
  needsOperator?: boolean;
  /** `delivery_failed`: the undelivered reply. */
  messageId?: string | null;
  /** `assigned`: the members who were added. */
  userIds?: string[];
}

/** One pending `incoming` job per ticket: messages arriving during the wait join it. BullMQ rejects ids with a single colon. */
export function incomingJobId(ticketId: string): string {
  return `incoming-${ticketId}`;
}
