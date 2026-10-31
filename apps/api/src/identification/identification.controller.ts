import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import {
  CreateIdentificationRuleSchema,
  IdentificationSettingsSchema,
  UpdateIdentificationRuleSchema,
  type CreateIdentificationRuleInput,
  type IdentificationCheckDto,
  type IdentificationRuleDto,
  type IdentificationSettingsDto,
  type UpdateIdentificationRuleInput,
} from '@kvitok/shared';
import { z } from 'zod';
import { RequireScope } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireRole, WorkspaceGuard } from '../workspaces/workspace.guard';
import { IdentificationService } from './identification.service';

@Controller('workspaces/:workspaceId/identification')
@UseGuards(WorkspaceGuard)
@RequireScope('config:write')
@RequireRole('admin')
export class IdentificationController {
  constructor(private readonly identification: IdentificationService) {}

  @Get('rules')
  @RequireRole('viewer')
  list(@Param('workspaceId') workspaceId: string): Promise<IdentificationRuleDto[]> {
    return this.identification.list(workspaceId);
  }

  @Post('rules')
  create(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreateIdentificationRuleSchema)) body: CreateIdentificationRuleInput,
  ): Promise<IdentificationRuleDto> {
    return this.identification.create(workspaceId, body);
  }

  @Patch('rules/:ruleId')
  update(
    @Param('workspaceId') workspaceId: string,
    @Param('ruleId') ruleId: string,
    @Body(new ZodValidationPipe(UpdateIdentificationRuleSchema)) body: UpdateIdentificationRuleInput,
  ): Promise<IdentificationRuleDto> {
    return this.identification.update(workspaceId, ruleId, body);
  }

  @Delete('rules/:ruleId')
  @HttpCode(204)
  remove(@Param('workspaceId') workspaceId: string, @Param('ruleId') ruleId: string): Promise<void> {
    return this.identification.remove(workspaceId, ruleId);
  }

  @Post('check')
  @HttpCode(200)
  @RequireRole('viewer')
  check(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(z.object({ ticketId: z.string().min(1) }))) body: { ticketId: string },
  ): Promise<IdentificationCheckDto> {
    return this.identification.check(workspaceId, body.ticketId);
  }

  @Get('settings')
  @RequireRole('viewer')
  settings(@Param('workspaceId') workspaceId: string): Promise<IdentificationSettingsDto> {
    return this.identification.settings(workspaceId);
  }

  @Patch('settings')
  updateSettings(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(IdentificationSettingsSchema)) body: IdentificationSettingsDto,
  ): Promise<IdentificationSettingsDto> {
    return this.identification.updateSettings(workspaceId, body);
  }
}
