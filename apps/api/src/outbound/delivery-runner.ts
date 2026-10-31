import { Injectable, Logger } from '@nestjs/common';
import { apiConfig } from '../channels/channel-config';
import { ChannelsService } from '../channels/channels.service';
import { EmailSender } from '../mail/email-sender';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { recordEvent, SYSTEM_ACTOR } from '../tickets/ticket-events';
import { WebhookDeliveryError, WebhookSender } from './webhook-sender';

export type DeliveryOutcome = 'sent' | 'skipped';

/** Executes one delivery. An error is rethrown so BullMQ retries. */
@Injectable()
export class DeliveryRunner {
  private readonly logger = new Logger(DeliveryRunner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelsService,
    private readonly email: EmailSender,
    private readonly webhook: WebhookSender,
    private readonly realtime: RealtimeService,
  ) {}

  async run(deliveryId: string, options: { finalAttempt: boolean }): Promise<DeliveryOutcome> {
    // queued → sending atomically: a cancelled or already sent delivery will not go out again.
    // sending is taken too — that is a retry after the worker crashed mid-send.
    const claimed = await this.prisma.delivery.updateMany({
      where: { id: deliveryId, status: { in: ['queued', 'sending'] } },
      data: { status: 'sending', attempts: { increment: 1 } },
    });
    if (claimed.count === 0) {
      return 'skipped';
    }

    const delivery = await this.prisma.delivery.findUniqueOrThrow({
      where: { id: deliveryId },
      include: { channel: true, message: { include: { attachments: true } } },
    });

    try {
      let providerMessageId: string | null = null;
      let responseStatus: number | null = null;

      if (delivery.kind === 'email') {
        if (delivery.message === null) {
          throw new Error('Email delivery without message');
        }
        ({ providerMessageId } = await this.email.send(this.channels.resolveMailbox(delivery.channel), delivery.message, delivery.id));
      } else {
        const url = apiConfig(delivery.channel).webhookUrl;
        const secret = this.channels.webhookSecret(delivery.channel);
        if (!url || !secret) {
          throw new Error('Webhook is not configured for channel');
        }
        responseStatus = await this.webhook.send({
          url,
          secret,
          deliveryId: delivery.id,
          event: delivery.event ?? 'unknown',
          payload: delivery.payload,
        });
      }

      await this.prisma.delivery.update({
        where: { id: deliveryId },
        data: { status: 'sent', sentAt: new Date(), lastError: null, providerMessageId, responseStatus },
      });
      await this.publish(delivery.workspaceId, delivery.ticketId, delivery.messageId, deliveryId, 'sent');
      return 'sent';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const responseStatus = error instanceof WebhookDeliveryError ? error.status : null;
      this.logger.warn(`Delivery ${deliveryId} failed (final=${options.finalAttempt}): ${message}`);

      await this.prisma.delivery.update({
        where: { id: deliveryId },
        data: { status: options.finalAttempt ? 'failed' : 'queued', lastError: message.slice(0, 1000), responseStatus },
      });
      if (options.finalAttempt) {
        if (delivery.ticketId) {
          await this.prisma.$transaction((tx) =>
            recordEvent(tx, {
              workspaceId: delivery.workspaceId,
              ticketId: delivery.ticketId!,
              type: 'delivery_failed',
              actor: SYSTEM_ACTOR,
              data: { deliveryId, kind: delivery.kind, messageId: delivery.messageId, error: message.slice(0, 500) },
            }),
          );
        }
        await this.publish(delivery.workspaceId, delivery.ticketId, delivery.messageId, deliveryId, 'failed');
      }
      throw error;
    }
  }

  private async publish(workspaceId: string, ticketId: string | null, messageId: string | null, deliveryId: string, status: string) {
    if (ticketId) {
      await this.realtime.publish(workspaceId, { type: 'delivery.updated', ticketId, messageId, deliveryId, status });
    }
  }
}
