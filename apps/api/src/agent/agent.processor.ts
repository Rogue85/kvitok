import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { Job } from 'bullmq';
import { AGENT_QUEUE, RUN_JOB, type RunJobData } from './agent.constants';
import { AgentCoreModule } from './agent-core.module';
import { AgentEngine } from './agent-engine';

@Processor(AGENT_QUEUE, { concurrency: 4, lockDuration: 5 * 60 * 1000 })
export class AgentProcessor extends WorkerHost {
  constructor(private readonly engine: AgentEngine) {
    super();
  }

  process(job: Job<RunJobData>): Promise<unknown> {
    if (job.name === RUN_JOB) {
      return this.engine.processTicket(job.data.ticketId, job.id!);
    }
    throw new Error(`Unknown agent job: ${job.name}`);
  }
}

/** Agent runs — in the worker only. */
@Module({
  imports: [AgentCoreModule],
  providers: [AgentProcessor],
})
export class AgentWorkerModule {}
