import { Body, Controller, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import {
  AcceptSuggestionSchema,
  AnswerQuestionSchema,
  DryRunSchema,
  LinkCustomerSchema,
  RunAgentSchema,
  SaveDraftSchema,
  type AcceptSuggestionInput,
  type AgentRunDetailDto,
  type CustomerLinkDto,
  type DryRunInput,
  type LinkCustomerInput,
  type MessageDto,
  type PromptPreviewDto,
  type ReplyDraftDto,
  type TicketAgentDto,
} from '@kvitok/shared';
import { CurrentAuth } from '../auth/decorators';
import type { AuthContext } from '../common/request';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { TicketsService } from '../tickets/tickets.service';
import { RequireRole, WorkspaceGuard } from '../workspaces/workspace.guard';
import { AgentService } from './agent.service';
import { DraftsService, toDraftDto } from './drafts.service';

@Controller('workspaces/:workspaceId')
@UseGuards(WorkspaceGuard)
@RequireRole('operator')
export class AgentController {
  constructor(
    private readonly agent: AgentService,
    private readonly drafts: DraftsService,
    private readonly tickets: TicketsService,
  ) {}

  @Get('tickets/:ticketId/agent')
  @RequireRole('viewer')
  ticketAgent(@Param('workspaceId') workspaceId: string, @Param('ticketId') ticketId: string): Promise<TicketAgentDto> {
    return this.agent.ticketAgent(workspaceId, ticketId);
  }

  @Get('agent/runs/:runId')
  @RequireRole('viewer')
  runDetail(@Param('workspaceId') workspaceId: string, @Param('runId') runId: string): Promise<AgentRunDetailDto> {
    return this.agent.runDetail(workspaceId, runId);
  }

  @Get('tickets/:ticketId/customer-links')
  customerLinks(@Param('workspaceId') workspaceId: string, @Param('ticketId') ticketId: string): Promise<CustomerLinkDto[]> {
    return this.agent.customerLinks(workspaceId, ticketId);
  }

  @Post('tickets/:ticketId/customer-links/:integrationId')
  @HttpCode(200)
  linkCustomer(
    @Param('workspaceId') workspaceId: string,
    @Param('ticketId') ticketId: string,
    @Param('integrationId') integrationId: string,
    @Body(new ZodValidationPipe(LinkCustomerSchema)) body: LinkCustomerInput,
    @CurrentAuth() auth: AuthContext,
  ): Promise<{ outcome: 'found' | 'not_found' | 'ambiguous'; link: CustomerLinkDto }> {
    return this.agent.linkCustomer(workspaceId, ticketId, integrationId, body, auth.user.id);
  }

  @Post('tickets/:ticketId/agent/run')
  @HttpCode(202)
  async run(
    @Param('workspaceId') workspaceId: string,
    @Param('ticketId') ticketId: string,
    @Body(new ZodValidationPipe(RunAgentSchema)) body: { mode: 'triage' | 'refine' },
    @CurrentAuth() auth: AuthContext,
  ): Promise<{ queued: true }> {
    await this.agent.run(workspaceId, ticketId, auth.user.id, body.mode);
    return { queued: true };
  }

  @Post('tickets/:ticketId/agent/dry-run')
  @HttpCode(200)
  @RequireRole('admin')
  dryRun(
    @Param('workspaceId') workspaceId: string,
    @Param('ticketId') ticketId: string,
    @Body(new ZodValidationPipe(DryRunSchema)) body: DryRunInput,
  ) {
    return this.agent.dryRun(workspaceId, ticketId, body);
  }

  @Get('tickets/:ticketId/agent/prompt-preview')
  @RequireRole('admin')
  promptPreview(@Param('workspaceId') workspaceId: string, @Param('ticketId') ticketId: string): Promise<PromptPreviewDto> {
    return this.agent.promptPreview(workspaceId, ticketId);
  }

  @Post('tickets/:ticketId/agent/questions/:questionId/answer')
  answer(
    @Param('workspaceId') workspaceId: string,
    @Param('ticketId') ticketId: string,
    @Param('questionId') questionId: string,
    @Body(new ZodValidationPipe(AnswerQuestionSchema)) body: { body: string },
    @CurrentAuth() auth: AuthContext,
  ): Promise<MessageDto> {
    return this.agent.answerQuestion(workspaceId, ticketId, questionId, auth.user.id, body.body);
  }

  @Post('tickets/:ticketId/agent/questions/:questionId/dismiss')
  @HttpCode(204)
  dismiss(@Param('workspaceId') workspaceId: string, @Param('ticketId') ticketId: string, @Param('questionId') questionId: string): Promise<void> {
    return this.agent.dismissQuestion(workspaceId, ticketId, questionId);
  }

  @Post('tickets/:ticketId/agent/suggestions/accept')
  @HttpCode(204)
  accept(
    @Param('workspaceId') workspaceId: string,
    @Param('ticketId') ticketId: string,
    @Body(new ZodValidationPipe(AcceptSuggestionSchema)) body: AcceptSuggestionInput,
    @CurrentAuth() auth: AuthContext,
  ): Promise<void> {
    return this.agent.acceptSuggestion(workspaceId, ticketId, auth.user.id, body);
  }

  @Post('tickets/:ticketId/agent/suggestions/reject')
  @HttpCode(204)
  reject(
    @Param('workspaceId') workspaceId: string,
    @Param('ticketId') ticketId: string,
    @Body(new ZodValidationPipe(AcceptSuggestionSchema)) body: AcceptSuggestionInput,
  ): Promise<void> {
    return this.agent.rejectSuggestion(workspaceId, ticketId, body);
  }

  @Put('tickets/:ticketId/draft')
  async saveDraft(
    @Param('workspaceId') workspaceId: string,
    @Param('ticketId') ticketId: string,
    @Body(new ZodValidationPipe(SaveDraftSchema)) body: { bodyHtml: string },
    @CurrentAuth() auth: AuthContext,
  ): Promise<ReplyDraftDto | null> {
    await this.tickets.get(workspaceId, ticketId);
    return toDraftDto(await this.drafts.saveOperatorDraft(workspaceId, ticketId, auth.user.id, body.bodyHtml));
  }

  @Post('tickets/:ticketId/drafts/:draftId/accept')
  async acceptDraft(
    @Param('workspaceId') workspaceId: string,
    @Param('ticketId') ticketId: string,
    @Param('draftId') draftId: string,
  ): Promise<ReplyDraftDto | null> {
    return toDraftDto(await this.drafts.acceptSuggested(workspaceId, ticketId, draftId));
  }

  @Post('tickets/:ticketId/drafts/:draftId/discard')
  @HttpCode(204)
  discardDraft(@Param('workspaceId') workspaceId: string, @Param('ticketId') ticketId: string, @Param('draftId') draftId: string): Promise<void> {
    return this.drafts.discardSuggested(workspaceId, ticketId, draftId);
  }
}
