import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import {
  ApproveActionSchema,
  CreateActionSchema,
  RejectActionSchema,
  type ActionCatalogIntegration,
  type ActionProposalDto,
  type ApproveActionInput,
  type CreateActionInput,
  type RejectActionInput,
} from '@kvitok/shared';
import { CurrentAuth } from '../auth/decorators';
import type { AuthContext } from '../common/request';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireRole, WorkspaceGuard } from '../workspaces/workspace.guard';
import { ActionsService } from './actions.service';

/** Manual actions of operators: what can be started by hand and proposing one. */
@Controller('workspaces/:workspaceId/tickets/:ticketId/actions')
@UseGuards(WorkspaceGuard)
@RequireRole('operator')
export class TicketActionsController {
  constructor(private readonly actions: ActionsService) {}

  @Get('catalog')
  catalog(@Param('workspaceId') workspaceId: string, @Param('ticketId') ticketId: string): Promise<ActionCatalogIntegration[]> {
    return this.actions.catalog(workspaceId, ticketId);
  }

  @Post()
  create(
    @Param('workspaceId') workspaceId: string,
    @Param('ticketId') ticketId: string,
    @Body(new ZodValidationPipe(CreateActionSchema)) body: CreateActionInput,
    @CurrentAuth() auth: AuthContext,
  ): Promise<ActionProposalDto> {
    return this.actions.create(workspaceId, ticketId, auth.user.id, body);
  }
}

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
    return this.actions.approve(workspaceId, ticketId, actionId, auth.user.id, body.comment, body.pending);
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
