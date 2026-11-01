import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AnalyticsQuerySchema, type AnalyticsDto, type AnalyticsQuery } from '@kvitok/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { WorkspaceContext } from '../common/request';
import { CurrentWorkspace, WorkspaceGuard } from '../workspaces/workspace.guard';
import { AnalyticsService } from './analytics.service';

@Controller('workspaces/:workspaceId/analytics')
@UseGuards(WorkspaceGuard)
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get()
  report(@CurrentWorkspace() workspace: WorkspaceContext, @Query(new ZodValidationPipe(AnalyticsQuerySchema)) query: AnalyticsQuery): Promise<AnalyticsDto> {
    return this.analytics.report(workspace, query);
  }
}
