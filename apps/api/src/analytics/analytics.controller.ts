import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AnalyticsQuerySchema, type AnalyticsDto, type AnalyticsQuery } from '@kvitok/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { WorkspaceGuard } from '../workspaces/workspace.guard';
import { AnalyticsService } from './analytics.service';

@Controller('workspaces/:workspaceId/analytics')
@UseGuards(WorkspaceGuard)
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get()
  report(@Param('workspaceId') workspaceId: string, @Query(new ZodValidationPipe(AnalyticsQuerySchema)) query: AnalyticsQuery): Promise<AnalyticsDto> {
    return this.analytics.report(workspaceId, query);
  }
}
