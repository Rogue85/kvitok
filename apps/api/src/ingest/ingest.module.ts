import { Module } from '@nestjs/common';
import { AgentTriggerModule } from '../agent/agent-trigger.module';
import { RoutingModule } from '../routing/routing.module';
import { ChannelsModule } from '../channels/channels.module';
import { CustomersModule } from '../customers/customers.module';
import { FieldsModule } from '../fields/fields.module';
import { TicketsModule } from '../tickets/tickets.module';
import { InboundService } from './inbound.service';
import { IngestAuthGuard } from './ingest-auth.guard';
import { IngestController } from './ingest.controller';

@Module({
  imports: [ChannelsModule, CustomersModule, FieldsModule, TicketsModule, RoutingModule, AgentTriggerModule],
  controllers: [IngestController],
  providers: [InboundService, IngestAuthGuard],
  exports: [InboundService],
})
export class IngestModule {}
