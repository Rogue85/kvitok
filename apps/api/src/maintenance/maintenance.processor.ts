import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { SessionCleanupService } from '../auth/session-cleanup.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { MAINTENANCE_QUEUE, MaintenanceJob } from './maintenance.constants';

@Processor(MAINTENANCE_QUEUE)
export class MaintenanceProcessor extends WorkerHost {
  private readonly logger = new Logger(MaintenanceProcessor.name);

  constructor(
    private readonly sessions: SessionCleanupService,
    private readonly integrations: IntegrationsService,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case MaintenanceJob.cleanupSessions: {
        const deleted = await this.sessions.deleteExpired();
        if (deleted > 0) {
          this.logger.log(`Deleted ${deleted} expired sessions`);
        }
        return { deleted };
      }
      case MaintenanceJob.syncIntegrations: {
        // The manifest is checked by ETag: if the backend changed nothing, it is a cheap 304.
        await this.integrations.syncAll();
        return { ok: true };
      }
      default:
        throw new Error(`Unknown maintenance job: ${job.name}`);
    }
  }
}
