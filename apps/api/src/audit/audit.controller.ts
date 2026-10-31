import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuditQuerySchema, type AuditLogDto, type AuditQuery } from '@kvitok/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireRole, WorkspaceGuard } from '../workspaces/workspace.guard';
import { AuditService } from './audit.service';

@Controller('workspaces/:workspaceId/audit')
@UseGuards(WorkspaceGuard)
@RequireRole('admin')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Param('workspaceId') workspaceId: string, @Query(new ZodValidationPipe(AuditQuerySchema)) query: AuditQuery): Promise<AuditLogDto[]> {
    return this.audit.list(workspaceId, query);
  }
}
