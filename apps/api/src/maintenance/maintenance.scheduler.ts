import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { MAINTENANCE_QUEUE, MaintenanceJob } from './maintenance.constants';

@Injectable()
export class MaintenanceScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(MAINTENANCE_QUEUE) private readonly queue: Queue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      MaintenanceJob.cleanupSessions,
      { every: 60 * 60 * 1000 },
      { name: MaintenanceJob.cleanupSessions, opts: { removeOnComplete: 100, removeOnFail: 100 } },
    );
    await this.queue.upsertJobScheduler(
      MaintenanceJob.syncIntegrations,
      { every: this.config.integrationSyncMinutes * 60 * 1000 },
      { name: MaintenanceJob.syncIntegrations, opts: { removeOnComplete: 100, removeOnFail: 100 } },
    );
  }
}
