import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { OUTBOUND_QUEUE } from './outbound.constants';
import { OutboundService } from './outbound.service';

@Module({
  imports: [BullModule.registerQueue({ name: OUTBOUND_QUEUE })],
  providers: [OutboundService],
  exports: [OutboundService, BullModule],
})
export class OutboundModule {}
