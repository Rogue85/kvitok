import { Module } from '@nestjs/common';
import { DepartmentsModule } from '../departments/departments.module';
import { CustomerLinksService } from './customer-links.service';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';

@Module({
  imports: [DepartmentsModule],
  controllers: [IntegrationsController],
  providers: [IntegrationsService, CustomerLinksService],
  exports: [IntegrationsService, CustomerLinksService],
})
export class IntegrationsModule {}
