import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { SessionCleanupService } from '../auth/session-cleanup.service';
import { IntegrationsModule } from '../integrations/integrations.module';
import { MAINTENANCE_QUEUE } from './maintenance.constants';
import { MaintenanceProcessor } from './maintenance.processor';
import { MaintenanceScheduler } from './maintenance.scheduler';

@Module({
  imports: [BullModule.registerQueue({ name: MAINTENANCE_QUEUE }), IntegrationsModule],
  providers: [SessionCleanupService, MaintenanceProcessor, MaintenanceScheduler],
})
export class MaintenanceModule {}
