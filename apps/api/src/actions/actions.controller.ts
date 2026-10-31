import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApproveActionSchema, RejectActionSchema, type ActionProposalDto, type ApproveActionInput, type RejectActionInput } from '@kvitok/shared';
import { CurrentAuth } from '../auth/decorators';
import type { AuthContext } from '../common/request';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireRole, WorkspaceGuard } from '../workspaces/workspace.guard';
import { ActionsService } from './actions.service';

@Controller('workspaces/:workspaceId/tickets/:ticketId/actions/:actionId')
@UseGuards(WorkspaceGuard)
@RequireRole('operator')
export class ActionsController {
  constructor(private readonly actions: ActionsService) {}

  @Post('approve')
  @HttpCode(200)
  approve(
    @Param('workspaceId') workspaceId: string,
    @Param('ticketId') ticketId: string,
    @Param('actionId') actionId: string,
    @Body(new ZodValidationPipe(ApproveActionSchema)) body: ApproveActionInput,
    @CurrentAuth() auth: AuthContext,
  ): Promise<ActionProposalDto> {
    return this.actions.approve(workspaceId, ticketId, actionId, auth.user.id, body.comment);
  }

  @Post('reject')
  @HttpCode(200)
  reject(
    @Param('workspaceId') workspaceId: string,
    @Param('ticketId') ticketId: string,
    @Param('actionId') actionId: string,
    @Body(new ZodValidationPipe(RejectActionSchema)) body: RejectActionInput,
    @CurrentAuth() auth: AuthContext,
  ): Promise<ActionProposalDto> {
    return this.actions.reject(workspaceId, ticketId, actionId, auth.user.id, body.comment);
  }

  @Post('retry')
  @HttpCode(200)
  retry(
    @Param('workspaceId') workspaceId: string,
    @Param('ticketId') ticketId: string,
    @Param('actionId') actionId: string,
    @CurrentAuth() auth: AuthContext,
  ): Promise<ActionProposalDto> {
    return this.actions.retry(workspaceId, ticketId, actionId, auth.user.id);
  }
}
