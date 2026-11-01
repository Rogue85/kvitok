import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { NOTIFY_QUEUE } from './notifications.constants';
import { NotificationsService } from './notifications.service';

/** Queuing notifications — global, since tickets, ingest, the agent and deliveries all cause them. */
@Global()
@Module({
  imports: [BullModule.registerQueue({ name: NOTIFY_QUEUE })],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
