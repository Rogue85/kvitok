import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import {
  CreateLlmProviderSchema,
  CreatePlaybookSchema,
  UpdateAgentSettingsSchema,
  UpdateLlmProviderSchema,
  UpdatePlaybookSchema,
  type AgentSettingsDto,
  type CreateLlmProviderInput,
  type CreatePlaybookInput,
  type LlmProviderDto,
  type PlaybookDto,
  type UpdateAgentSettingsInput,
  type UpdateLlmProviderInput,
  type UpdatePlaybookInput,
} from '@kvitok/shared';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireRole, WorkspaceGuard } from '../workspaces/workspace.guard';
import { AgentSettingsService } from './agent-settings.service';
import { LlmProvidersService } from './llm-providers.service';
import { PlaybooksService } from './playbooks.service';

@Controller('workspaces/:workspaceId')
@UseGuards(WorkspaceGuard)
@RequireRole('admin')
export class AgentConfigController {
  constructor(
    private readonly settings: AgentSettingsService,
    private readonly providers: LlmProvidersService,
    private readonly playbooks: PlaybooksService,
  ) {}

  @Get('agent/settings')
  @RequireRole('viewer')
  getSettings(@Param('workspaceId') workspaceId: string): Promise<AgentSettingsDto> {
    return this.settings.getDto(workspaceId);
  }

  @Put('agent/settings')
  updateSettings(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(UpdateAgentSettingsSchema)) body: UpdateAgentSettingsInput,
  ): Promise<AgentSettingsDto> {
    return this.settings.update(workspaceId, body);
  }

  @Get('llm-providers')
  listProviders(@Param('workspaceId') workspaceId: string): Promise<LlmProviderDto[]> {
    return this.providers.list(workspaceId);
  }

  @Post('llm-providers')
  createProvider(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreateLlmProviderSchema)) body: CreateLlmProviderInput,
  ): Promise<LlmProviderDto> {
    return this.providers.create(workspaceId, body);
  }

  @Patch('llm-providers/:providerId')
  updateProvider(
    @Param('workspaceId') workspaceId: string,
    @Param('providerId') providerId: string,
    @Body(new ZodValidationPipe(UpdateLlmProviderSchema)) body: UpdateLlmProviderInput,
  ): Promise<LlmProviderDto> {
    return this.providers.update(workspaceId, providerId, body);
  }

  @Delete('llm-providers/:providerId')
  @HttpCode(204)
  removeProvider(@Param('workspaceId') workspaceId: string, @Param('providerId') providerId: string): Promise<void> {
    return this.providers.remove(workspaceId, providerId);
  }

  @Post('llm-providers/:providerId/test')
  @HttpCode(200)
  testProvider(
    @Param('workspaceId') workspaceId: string,
    @Param('providerId') providerId: string,
    @Body(new ZodValidationPipe(z.object({ model: z.string().min(1) }))) body: { model: string },
  ) {
    return this.providers.test(workspaceId, providerId, body.model);
  }

  @Get('playbooks')
  @RequireRole('viewer')
  listPlaybooks(@Param('workspaceId') workspaceId: string): Promise<PlaybookDto[]> {
    return this.playbooks.list(workspaceId);
  }

  @Post('playbooks')
  createPlaybook(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreatePlaybookSchema)) body: CreatePlaybookInput,
  ): Promise<PlaybookDto> {
    return this.playbooks.create(workspaceId, body);
  }

  @Patch('playbooks/:playbookId')
  updatePlaybook(
    @Param('workspaceId') workspaceId: string,
    @Param('playbookId') playbookId: string,
    @Body(new ZodValidationPipe(UpdatePlaybookSchema)) body: UpdatePlaybookInput,
  ): Promise<PlaybookDto> {
    return this.playbooks.update(workspaceId, playbookId, body);
  }

  @Delete('playbooks/:playbookId')
  @HttpCode(204)
  removePlaybook(@Param('workspaceId') workspaceId: string, @Param('playbookId') playbookId: string): Promise<void> {
    return this.playbooks.remove(workspaceId, playbookId);
  }
}
