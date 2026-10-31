import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import {
  CreateIntegrationSchema,
  ImportDepartmentsSchema,
  SyncIntegrationSchema,
  UpdateIntegrationSchema,
  type CreateIntegrationInput,
  type DepartmentDto,
  type ImportDepartmentsInput,
  type IntegrationDto,
  type IntegrationSyncResultDto,
  type UpdateIntegrationInput,
} from '@kvitok/shared';
import { RequireScope } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireRole, WorkspaceGuard } from '../workspaces/workspace.guard';
import { IntegrationsService } from './integrations.service';

@Controller('workspaces/:workspaceId/integrations')
@UseGuards(WorkspaceGuard)
@RequireScope('integrations:write')
@RequireRole('admin')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  @RequireRole('viewer')
  list(@Param('workspaceId') workspaceId: string): Promise<IntegrationDto[]> {
    return this.integrations.list(workspaceId);
  }

  @Post()
  create(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreateIntegrationSchema)) body: CreateIntegrationInput,
  ): Promise<{ integration: IntegrationDto; sync: IntegrationSyncResultDto }> {
    return this.integrations.create(workspaceId, body);
  }

  @Patch(':integrationId')
  update(
    @Param('workspaceId') workspaceId: string,
    @Param('integrationId') integrationId: string,
    @Body(new ZodValidationPipe(UpdateIntegrationSchema)) body: UpdateIntegrationInput,
  ): Promise<IntegrationDto> {
    return this.integrations.update(workspaceId, integrationId, body);
  }

  @Delete(':integrationId')
  @HttpCode(204)
  remove(@Param('workspaceId') workspaceId: string, @Param('integrationId') integrationId: string): Promise<void> {
    return this.integrations.remove(workspaceId, integrationId);
  }

  @Post(':integrationId/sync')
  @HttpCode(200)
  async sync(
    @Param('workspaceId') workspaceId: string,
    @Param('integrationId') integrationId: string,
    @Body(new ZodValidationPipe(SyncIntegrationSchema)) body: { force: boolean },
  ): Promise<{ integration: IntegrationDto; sync: IntegrationSyncResultDto }> {
    const sync = await this.integrations.sync(workspaceId, integrationId, body);
    return { integration: await this.integrations.getDto(workspaceId, integrationId), sync };
  }

  @Post(':integrationId/import-departments')
  importDepartments(
    @Param('workspaceId') workspaceId: string,
    @Param('integrationId') integrationId: string,
    @Body(new ZodValidationPipe(ImportDepartmentsSchema)) body: ImportDepartmentsInput,
  ): Promise<DepartmentDto[]> {
    return this.integrations.importDepartments(workspaceId, integrationId, body.keys);
  }
}
