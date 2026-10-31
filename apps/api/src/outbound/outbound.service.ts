import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { apiConfig } from '../channels/channel-config';
import { newId } from '../common/ids';
import { json } from '../common/json';
import type { Channel, Delivery, Prisma, Ticket } from '../generated/prisma/client';
import { DELIVER_JOB, DELIVERY_ATTEMPTS, OUTBOUND_QUEUE } from './outbound.constants';

export interface DeliverJobData {
  deliveryId: string;
}

/** Queues outbound deliveries (emails, webhooks to the source); the worker executes them. */
@Injectable()
export class OutboundService {
  constructor(@InjectQueue(OUTBOUND_QUEUE) private readonly queue: Queue<DeliverJobData>) {}

  /** A webhook to the ticket's API source, if configured. Call inside a transaction, then schedule(). */
  async createSourceWebhook(
    db: Prisma.TransactionClient,
    ticket: Ticket & { channel: Channel | null },
    event: string,
    payload: Record<string, unknown>,
    options: { messageId?: string; scheduledAt?: Date } = {},
  ): Promise<Delivery | null> {
    const channel = ticket.channel;
    if (channel === null || channel.type !== 'api' || !channel.enabled || !apiConfig(channel).webhookUrl) {
      return null;
    }
    return db.delivery.create({
      data: {
        id: newId(),
        workspaceId: ticket.workspaceId,
        ticketId: ticket.id,
        messageId: options.messageId ?? null,
        channelId: channel.id,
        kind: 'webhook',
        event,
        payload: json({ event, ...payload }),
        scheduledAt: options.scheduledAt ?? new Date(),
      },
    });
  }

  async schedule(deliveries: Array<Pick<Delivery, 'id' | 'scheduledAt'>>): Promise<void> {
    const now = Date.now();
    await Promise.all(
      deliveries.map((delivery) =>
        this.queue.add(
          DELIVER_JOB,
          { deliveryId: delivery.id },
          {
            jobId: delivery.id,
            delay: Math.max(0, delivery.scheduledAt.getTime() - now),
            attempts: DELIVERY_ATTEMPTS,
            backoff: { type: 'exponential', delay: 30_000 },
            removeOnComplete: 1000,
            removeOnFail: 1000,
          },
        ),
      ),
    );
  }

  /** Removes delivery jobs that have not started yet. */
  async cancel(deliveryIds: string[]): Promise<void> {
    await Promise.all(deliveryIds.map((id) => this.queue.remove(id)));
  }
}

export function ticketWebhookRef(ticket: Ticket): Record<string, unknown> {
  return {
    id: ticket.id,
    number: ticket.number,
    status: ticket.status,
    conversation_external_id: ticket.conversationExternalId,
  };
}
