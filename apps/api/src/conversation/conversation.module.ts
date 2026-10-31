import { Module } from '@nestjs/common';
import { AgentTriggerModule } from '../agent/agent-trigger.module';
import { FieldsModule } from '../fields/fields.module';
import { OutboundModule } from '../outbound/outbound.module';
import { TicketsModule } from '../tickets/tickets.module';
import { ConversationController } from './conversation.controller';
import { ConversationService } from './conversation.service';

@Module({
  imports: [TicketsModule, FieldsModule, OutboundModule, AgentTriggerModule],
  controllers: [ConversationController],
  providers: [ConversationService],
  exports: [ConversationService],
})
export class ConversationModule {}
