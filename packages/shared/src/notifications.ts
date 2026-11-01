import { z } from 'zod';
import { TicketPrioritySchema } from './tickets.js';

/**
 * Which tickets an event is sent for:
 * `mine` — assigned to the member, `mine_unassigned` — also tickets nobody took, `all` — every ticket that passes the filters.
 */
export const NotificationScopeSchema = z.enum(['off', 'mine', 'mine_unassigned', 'all']);
export type NotificationScope = z.infer<typeof NotificationScopeSchema>;

/** What a member of a workspace is notified about. Stored on the membership; missing keys take the defaults. */
export const NotificationSettingsSchema = z.object({
  events: z.object({
    /** A new ticket: `mine_unassigned` sends it while nobody took it; an assigned one goes to the assignee as `assigned`. */
    ticketCreated: z.enum(['off', 'mine_unassigned', 'all']).default('mine_unassigned'),
    assigned: z.boolean().default(true),
    customerMessage: NotificationScopeSchema.default('mine'),
    /** The agent asked the operator a question or proposed an action that waits for a decision. */
    agentNeedsOperator: NotificationScopeSchema.default('mine_unassigned'),
    /** `mine` — replies the member wrote. */
    deliveryFailed: z.enum(['off', 'mine', 'all']).default('mine'),
    /** Only for admins. */
    agentFailed: z.boolean().default(false),
  }),
  /** Departments of tickets not assigned to the member; null — all. */
  departmentIds: z.array(z.string().min(1)).max(200).nullable().default(null),
  /** With `departmentIds`: also tickets without a department. */
  noDepartment: z.boolean().default(true),
  /** Tickets not assigned to the member with a lower priority are skipped. */
  minPriority: TicketPrioritySchema.default('low'),
});
export type NotificationSettings = z.output<typeof NotificationSettingsSchema>;
export type NotificationSettingsInput = z.input<typeof NotificationSettingsSchema>;

/** Stored settings with the defaults filled in; broken ones fall back to the defaults entirely. */
export function notificationSettings(stored: unknown): NotificationSettings {
  const value = typeof stored === 'object' && stored !== null ? stored : {};
  const parsed = NotificationSettingsSchema.safeParse({ events: {}, ...value });
  return parsed.success ? parsed.data : NotificationSettingsSchema.parse({ events: {} });
}

export const PushSubscriptionInputSchema = z.object({
  endpoint: z.url().max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(100),
  }),
});
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionInputSchema>;

export interface PushSubscriptionDto {
  id: string;
  userAgent: string | null;
  /** Subscribed in the session of this request. */
  current: boolean;
  createdAt: string;
  lastSuccessAt: string | null;
  lastError: string | null;
}

export interface PushConfigDto {
  /** VAPID public key (base64url) for `PushManager.subscribe`. */
  publicKey: string;
  subscriptions: PushSubscriptionDto[];
}

/** What the service worker shows. */
export interface PushPayload {
  title: string;
  body: string;
  /** A path in the interface to open on click. */
  url: string;
  /** A newer notification with the same tag replaces the older one. */
  tag: string;
}
