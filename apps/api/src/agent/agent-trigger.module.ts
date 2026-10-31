import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AGENT_QUEUE } from './agent.constants';
import { AgentTriggerService } from './agent-trigger.service';

/** Queueing agent runs — needed by ingest, the conversation and the agent API. */
@Module({
  imports: [BullModule.registerQueue({ name: AGENT_QUEUE })],
  providers: [AgentTriggerService],
  exports: [AgentTriggerService, BullModule],
})
export class AgentTriggerModule {}
