import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { MailModule } from '../mail/mail.module';
import { DeliveryRunner } from './delivery-runner';
import { OutboundModule } from './outbound.module';
import { OutboundProcessor } from './outbound.processor';
import { WebhookSender } from './webhook-sender';

/** Executing deliveries — in the worker only. */
@Module({
  imports: [OutboundModule, ChannelsModule, MailModule],
  providers: [WebhookSender, DeliveryRunner, OutboundProcessor],
  exports: [DeliveryRunner],
})
export class OutboundWorkerModule {}
