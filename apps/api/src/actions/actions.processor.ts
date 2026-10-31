import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { BullModule } from '@nestjs/bullmq';
import { Logger, Module } from '@nestjs/common';
import type { Job } from 'bullmq';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ActionExecutor } from './action-executor';
import { ACTIONS_QUEUE, type ExecuteJobData } from './actions.constants';

@Processor(ACTIONS_QUEUE, { concurrency: 4 })
export class ActionsProcessor extends WorkerHost {
  private readonly logger = new Logger(ActionsProcessor.name);

  constructor(private readonly executor: ActionExecutor) {
    super();
  }

  process(job: Job<ExecuteJobData>): Promise<unknown> {
    return this.executor.execute(job.data.proposalId);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<ExecuteJobData>, error: Error): Promise<void> {
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      this.logger.warn(`Action ${job.data.proposalId} gave up: ${error.message}`);
      await this.executor.giveUp(job.data.proposalId, error.message);
    }
  }
}

/** Executing actions — in the worker only. */
@Module({
  imports: [BullModule.registerQueue({ name: ACTIONS_QUEUE }), IntegrationsModule],
  providers: [ActionExecutor, ActionsProcessor],
  exports: [ActionExecutor],
})
export class ActionsWorkerModule {}
