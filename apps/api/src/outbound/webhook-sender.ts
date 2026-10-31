import { Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';

export class WebhookDeliveryError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

/** Signature: `X-Support-Signature: sha256=<hex hmac(secret, "<timestamp>.<body>")>`. */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

@Injectable()
export class WebhookSender {
  async send(params: { url: string; secret: string; deliveryId: string; event: string; payload: unknown }): Promise<number> {
    const body = JSON.stringify(params.payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    let response: Response;
    try {
      response = await fetch(params.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'kvitok-webhook/1',
          'x-support-event': params.event,
          'x-support-delivery': params.deliveryId,
          'x-support-timestamp': timestamp,
          'x-support-signature': signWebhook(params.secret, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new WebhookDeliveryError(error instanceof Error ? error.message : String(error), null);
    }
    if (!response.ok) {
      throw new WebhookDeliveryError(`HTTP ${response.status}`, response.status);
    }
    return response.status;
  }
}
