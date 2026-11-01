import { Injectable, Logger } from '@nestjs/common';
import webpush, { WebPushError } from 'web-push';
import type { PushPayload } from '@kvitok/shared';
import type { PushSubscription } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { Notification, NotifierChannel } from './notifier-channel';
import { VapidKeysService } from './vapid-keys.service';

/** How long a push service keeps a notification for an offline device. */
const TTL_SECONDS = 24 * 60 * 60;
const TIMEOUT_MS = 10_000;

/** Sends web push to every browser of a user; a subscription the push service no longer knows is deleted. */
@Injectable()
export class WebPushSender implements NotifierChannel {
  private readonly logger = new Logger(WebPushSender.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vapid: VapidKeysService,
  ) {}

  async reachable(userIds: string[]): Promise<Set<string>> {
    const rows = await this.prisma.pushSubscription.findMany({ where: { userId: { in: userIds } }, select: { userId: true }, distinct: ['userId'] });
    return new Set(rows.map((row) => row.userId));
  }

  async deliver(userId: string, notification: Notification): Promise<void> {
    const subscriptions = await this.prisma.pushSubscription.findMany({ where: { userId } });
    await Promise.all(subscriptions.map((subscription) => this.send(subscription, notification, notification.urgent)));
  }

  /** Sends to one browser; returns the error text, or null when the push service accepted it. */
  async send(subscription: PushSubscription, payload: PushPayload, urgent = false): Promise<string | null> {
    const keys = await this.vapid.get();
    try {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        JSON.stringify(payload),
        {
          vapidDetails: { subject: this.vapid.subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
          TTL: TTL_SECONDS,
          urgency: urgent ? 'high' : 'normal',
          timeout: TIMEOUT_MS,
        },
      );
      await this.prisma.pushSubscription.updateMany({ where: { id: subscription.id }, data: { lastSuccessAt: new Date(), lastError: null } });
      return null;
    } catch (error) {
      // 404 and 410: the browser unsubscribed or the subscription expired.
      if (error instanceof WebPushError && (error.statusCode === 404 || error.statusCode === 410)) {
        await this.prisma.pushSubscription.deleteMany({ where: { id: subscription.id } });
        return describe(error);
      }
      const message = describe(error);
      this.logger.warn(`Web push to subscription ${subscription.id} failed: ${message}`);
      await this.prisma.pushSubscription.updateMany({ where: { id: subscription.id }, data: { lastError: message.slice(0, 500) } });
      return message;
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof WebPushError) return `${error.statusCode}: ${error.body || error.message}`.trim();
  return error instanceof Error ? error.message : String(error);
}
