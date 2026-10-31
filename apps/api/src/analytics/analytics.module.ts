import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { QualityReportService } from './quality-report.service';

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService, QualityReportService],
  exports: [QualityReportService],
})
export class AnalyticsModule {}
