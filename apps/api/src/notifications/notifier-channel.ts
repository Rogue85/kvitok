import type { PushPayload } from '@kvitok/shared';

export interface Notification extends PushPayload {
  /** urgent and high priority tickets: delivered right away even on a device saving battery. */
  urgent: boolean;
}

/** Where notifications go: web push now; ntfy, Telegram and others later. */
export interface NotifierChannel {
  /** Users with at least one target in this channel; the others are skipped before rendering. */
  reachable(userIds: string[]): Promise<Set<string>>;
  deliver(userId: string, notification: Notification): Promise<void>;
}

export const NOTIFIER_CHANNELS = Symbol('NOTIFIER_CHANNELS');
