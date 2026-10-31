import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import {
  CreateRoutingRuleSchema,
  UpdateRoutingRuleSchema,
  type CreateRoutingRuleInput,
  type RoutingRuleDto,
  type RuleTestResultDto,
  type UpdateRoutingRuleInput,
} from '@kvitok/shared';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireRole, WorkspaceGuard } from '../workspaces/workspace.guard';
import { RoutingRulesService } from './routing-rules.service';

@Controller('workspaces/:workspaceId/routing-rules')
@UseGuards(WorkspaceGuard)
@RequireRole('admin')
export class RoutingController {
  constructor(private readonly rules: RoutingRulesService) {}

  @Get()
  @RequireRole('viewer')
  list(@Param('workspaceId') workspaceId: string): Promise<RoutingRuleDto[]> {
    return this.rules.list(workspaceId);
  }

  @Post()
  create(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreateRoutingRuleSchema)) body: CreateRoutingRuleInput,
  ): Promise<RoutingRuleDto> {
    return this.rules.create(workspaceId, body);
  }

  @Post('test')
  @HttpCode(200)
  @RequireRole('viewer')
  test(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(z.object({ ticketId: z.string().min(1) }))) body: { ticketId: string },
  ): Promise<RuleTestResultDto[]> {
    return this.rules.test(workspaceId, body.ticketId);
  }

  @Patch(':ruleId')
  update(
    @Param('workspaceId') workspaceId: string,
    @Param('ruleId') ruleId: string,
    @Body(new ZodValidationPipe(UpdateRoutingRuleSchema)) body: UpdateRoutingRuleInput,
  ): Promise<RoutingRuleDto> {
    return this.rules.update(workspaceId, ruleId, body);
  }

  @Delete(':ruleId')
  @HttpCode(204)
  remove(@Param('workspaceId') workspaceId: string, @Param('ruleId') ruleId: string): Promise<void> {
    return this.rules.remove(workspaceId, ruleId);
  }
}
