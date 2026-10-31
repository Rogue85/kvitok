import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { DeliveryRunner } from './delivery-runner';
import { DELIVERY_ATTEMPTS, OUTBOUND_QUEUE } from './outbound.constants';
import type { DeliverJobData } from './outbound.service';

@Processor(OUTBOUND_QUEUE, { concurrency: 5 })
export class OutboundProcessor extends WorkerHost {
  constructor(private readonly runner: DeliveryRunner) {
    super();
  }

  process(job: Job<DeliverJobData>): Promise<unknown> {
    const attempts = job.opts.attempts ?? DELIVERY_ATTEMPTS;
    return this.runner.run(job.data.deliveryId, { finalAttempt: job.attemptsMade + 1 >= attempts });
  }
}
