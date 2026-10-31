import { Module } from '@nestjs/common';
import { ActionsModule } from '../actions/actions.module';
import { ConversationModule } from '../conversation/conversation.module';
import { TicketsModule } from '../tickets/tickets.module';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { AgentCoreModule } from './agent-core.module';

@Module({
  imports: [AgentCoreModule, TicketsModule, ConversationModule, ActionsModule],
  controllers: [AgentController],
  providers: [AgentService],
  exports: [AgentService],
})
export class AgentModule {}
