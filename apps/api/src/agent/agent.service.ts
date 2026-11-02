import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import {
  type AcceptSuggestionInput,
  type AgentQuestionDto,
  type AgentRunDetailDto,
  type CustomerLinkDto,
  type DecideIdentificationInput,
  type DryRunInput,
  type LinkCustomerInput,
  type MessageDto,
  type PromptPreviewDto,
  type TicketAgentDto,
  type TicketAnalysis,
} from '@kvitok/shared';
import { ActionsService } from '../actions/actions.service';
import { summarizeUsage } from '../analytics/usage';
import { errors } from '../common/errors';
import { systemAccess, ticketScopeWhere, type TicketAccess } from '../departments/department-access';
import { json } from '../common/json';
import { ConversationService } from '../conversation/conversation.service';
import type { AgentQuestion } from '../generated/prisma/client';
import { CustomerLinksService } from '../integrations/customer-links.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { recordEvent } from '../tickets/ticket-events';
import { TicketsService } from '../tickets/tickets.service';
import { AgentEngine, toRunDto } from './agent-engine';
import { AgentSettingsService } from './agent-settings.service';
import { AgentTriggerService } from './agent-trigger.service';
import { ConfigSnapshotService } from './config-snapshot.service';
import { assembleContext } from './context-assembler';
import { DraftsService, toDraftDto } from './drafts.service';
import { IntegrationRuntimeService } from './integration-runtime';

@Injectable()
export class AgentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tickets: TicketsService,
    private readonly conversation: ConversationService,
    private readonly drafts: DraftsService,
    private readonly triggers: AgentTriggerService,
    private readonly engine: AgentEngine,
    private readonly config: ConfigSnapshotService,
    private readonly settings: AgentSettingsService,
    private readonly realtime: RealtimeService,
    private readonly links: CustomerLinksService,
    private readonly integrations: IntegrationRuntimeService,
    private readonly actions: ActionsService,
  ) {}

  customerLinks(workspaceId: string, ticketId: string): Promise<CustomerLinkDto[]> {
    return this.links.listForTicket(workspaceId, ticketId);
  }

  /** Manual customer link. A new link changes the agent input: revision++ and a refinement run. */
  async linkCustomer(
    workspaceId: string,
    ticketId: string,
    integrationId: string,
    input: LinkCustomerInput,
    userId: string,
  ): Promise<{ outcome: 'found' | 'not_found' | 'ambiguous'; link: CustomerLinkDto }> {
    const { outcome, link, changed } = await this.links.link(workspaceId, ticketId, integrationId, input);
    if (changed) {
      await this.prisma.$transaction(async (tx) => {
        await tx.ticket.update({ where: { id: ticketId }, data: { revision: { increment: 1 } } });
        await recordEvent(tx, {
          workspaceId,
          ticketId,
          type: 'customer_linked',
          actor: { type: 'user', id: userId },
          data: { integrationId, integration: link.integrationName, displayName: link.displayName, source: link.source },
        });
      });
      await this.triggers.trigger(ticketId, { type: 'customer_linked', userId }, { mode: 'refine' });
    }
    await this.realtime.publish(workspaceId, { type: 'ticket.updated', ticketId });
    return { outcome, link };
  }

  /**
   * The operator's answer to an identification card. Choosing a customer links them (confirmed, by hand);
   * rejecting drops the values from the messages. A changed link changes the agent input: revision++ and a refinement run.
   */
  async decideIdentification(workspaceId: string, ticketId: string, integrationId: string, input: DecideIdentificationInput, userId: string): Promise<CustomerLinkDto> {
    const { link, changed, chosen, claims } = await this.links.decide(workspaceId, ticketId, integrationId, input);
    await this.prisma.$transaction(async (tx) => {
      if (changed) {
        await tx.ticket.update({ where: { id: ticketId }, data: { revision: { increment: 1 } } });
      }
      await recordEvent(tx, {
        workspaceId,
        ticketId,
        type: chosen ? 'customer_linked' : 'identification_rejected',
        actor: { type: 'user', id: userId },
        data: chosen
          ? { integrationId, integration: link.integrationName, displayName: chosen.displayName, source: 'manual', via: 'identification' }
          : { integrationId, integration: link.integrationName, identities: claims.map((c) => ({ type: c.type, value: c.value })) },
      });
    });
    if (changed) {
      await this.triggers.trigger(ticketId, { type: 'customer_linked', userId }, { mode: 'refine' });
    }
    await this.realtime.publish(workspaceId, { type: 'ticket.updated', ticketId });
    return link;
  }

  async ticketAgent(access: TicketAccess, ticketId: string): Promise<TicketAgentDto> {
    const { workspaceId } = access;
    const ticket = await this.tickets.visible(access, ticketId);
    const [settings, questions, draftState, runs, usage, actions, workspace] = await Promise.all([
      this.settings.get(workspaceId),
      this.prisma.agentQuestion.findMany({ where: { ticketId, status: 'open' }, orderBy: { createdAt: 'asc' } }),
      this.drafts.state(ticketId),
      this.prisma.agentRun.findMany({ where: { ticketId }, orderBy: { createdAt: 'desc' }, take: 20, include: { configVersion: true } }),
      this.prisma.agentRun.findMany({ where: { ticketId }, select: { dryRun: true, tokensIn: true, tokensOut: true, cost: true } }),
      this.actions.listForTicket(ticketId),
      this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { currency: true } }),
    ]);
    return {
      enabled: settings.enabled,
      state: ticket.agentState,
      analysis: ticket.analysis as unknown as TicketAnalysis | null,
      questions: questions.map(toQuestionDto),
      draft: toDraftDto(draftState.draft),
      suggestedDraft: toDraftDto(draftState.suggested),
      runs: runs.map(toRunDto),
      cost: {
        currency: workspace.currency,
        usage: summarizeUsage(usage.filter((r) => !r.dryRun)),
        dryRuns: summarizeUsage(usage.filter((r) => r.dryRun)),
      },
      actions,
    };
  }

  /** A run of a ticket the caller may see: its input and steps hold the whole ticket and the customer's data. */
  async runDetail(access: TicketAccess, runId: string): Promise<AgentRunDetailDto> {
    const run = await this.prisma.agentRun.findFirst({
      where: { id: runId, workspaceId: access.workspaceId, ticket: ticketScopeWhere(access) },
      include: { configVersion: true, steps: { orderBy: { index: 'asc' } } },
    });
    if (run === null) throw errors.notFound(t('api.runNotFound'));
    return {
      ...toRunDto(run),
      output: run.output,
      inputSnapshot: run.inputSnapshot,
      steps: run.steps.map((s) => ({
        index: s.index,
        kind: s.kind as 'llm' | 'tool',
        name: s.name,
        input: s.input,
        output: s.output,
        error: s.error,
        tokensIn: s.tokensIn,
        tokensOut: s.tokensOut,
        durationMs: s.durationMs,
      })),
    };
  }

  async run(workspaceId: string, ticketId: string, userId: string, mode: 'triage' | 'refine'): Promise<void> {
    await this.tickets.get(workspaceId, ticketId);
    const queued = await this.triggers.trigger(ticketId, { type: 'manual', userId }, { mode });
    if (!queued) throw errors.validation([{ path: 'agent', message: t('api.agentDisabled'), code: 'custom' }]);
  }

  /** A run with the current configuration without applying it — to check the prompt or a new playbook version. */
  async dryRun(workspaceId: string, ticketId: string, override: DryRunInput = {}): Promise<{ run: AgentRunDetailDto; result: unknown }> {
    const ticket = await this.tickets.get(workspaceId, ticketId);
    const { run, result } = await this.engine.execute({
      ticketId,
      mode: 'refine',
      triggers: [{ type: 'manual' }],
      inputRevision: ticket.revision,
      dryRun: true,
      override,
    });
    // Admins only: they see every department.
    return { run: await this.runDetail(systemAccess(workspaceId), run.id), result: result ?? null };
  }

  async promptPreview(workspaceId: string, ticketId: string): Promise<PromptPreviewDto> {
    const ticket = await this.prisma.ticket.findFirst({
      where: { id: ticketId, workspaceId },
      include: { channel: true, customer: { include: { identities: true } } },
    });
    if (ticket === null) throw errors.notFound(t('api.ticketNotFound'));
    const { version, snapshot } = await this.config.resolve(workspaceId);
    const [messages, questions] = await Promise.all([
      this.prisma.message.findMany({ where: { ticketId }, include: { authorUser: true }, orderBy: { createdAt: 'asc' } }),
      this.prisma.agentQuestion.findMany({ where: { ticketId } }),
    ]);
    // The preview shows integration data too; calls to integrations are not recorded as run steps.
    const integrations = await this.integrations.prepare(ticket, { record: async () => {}, checkClaims: false });
    const context = assembleContext({
      snapshot,
      ticket,
      messages,
      questions,
      mode: 'triage',
      triggers: [{ type: 'manual' }],
      supportsTools: snapshot.provider?.capabilities.tools ?? true,
      integrations: integrations.views,
      serviceTools: integrations.serviceTools,
    });
    return {
      messages: context.messages.map((m) => ({ role: m.role, content: 'content' in m ? (m.content ?? '') : '' })),
      tools: context.tools,
      configVersion: version.number,
    };
  }

  /** An answer to the agent's question — a message to the agent linked to the question; the agent refines the analysis. */
  async answerQuestion(workspaceId: string, ticketId: string, questionId: string, userId: string, body: string): Promise<MessageDto> {
    const question = await this.findQuestion(workspaceId, ticketId, questionId);
    const message = await this.conversation.addAgentMessage(workspaceId, ticketId, userId, { body }, { answersQuestionId: question.id });
    await this.prisma.agentQuestion.update({ where: { id: question.id }, data: { status: 'answered', answerMessageId: message.id } });
    await this.triggers.trigger(ticketId, { type: 'question_answer', messageId: message.id, userId }, { mode: 'refine' });
    return message;
  }

  async dismissQuestion(workspaceId: string, ticketId: string, questionId: string): Promise<void> {
    const question = await this.findQuestion(workspaceId, ticketId, questionId);
    await this.prisma.agentQuestion.update({ where: { id: question.id }, data: { status: 'dismissed' } });
    await this.realtime.publish(workspaceId, { type: 'ticket.updated', ticketId });
  }

  /** Accepting an agent suggestion is an operator decision: the field or department gets pinned. */
  async acceptSuggestion(workspaceId: string, ticketId: string, userId: string, input: AcceptSuggestionInput): Promise<void> {
    const ticket = await this.tickets.get(workspaceId, ticketId);
    const analysis = ticket.analysis as unknown as TicketAnalysis | null;
    if (input.kind === 'department') {
      const suggestion = analysis?.departmentSuggestion;
      if (!suggestion) throw errors.notFound(t('api.noDepartmentSuggestion'));
      await this.tickets.update(workspaceId, ticketId, { departmentId: suggestion.departmentId }, userId);
    } else {
      const suggestion = analysis?.fieldSuggestions[input.key];
      if (!suggestion) throw errors.notFound(t('api.noFieldSuggestion'));
      await this.tickets.update(workspaceId, ticketId, { fields: { [input.key]: suggestion.value } }, userId);
    }
    await this.dropSuggestion(ticketId, input);
  }

  async rejectSuggestion(workspaceId: string, ticketId: string, input: AcceptSuggestionInput): Promise<void> {
    await this.tickets.get(workspaceId, ticketId);
    await this.dropSuggestion(ticketId, input);
    await this.realtime.publish(workspaceId, { type: 'ticket.updated', ticketId });
  }

  private async dropSuggestion(ticketId: string, input: AcceptSuggestionInput): Promise<void> {
    const ticket = await this.prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    const analysis = ticket.analysis as unknown as TicketAnalysis | null;
    if (!analysis) return;
    if (input.kind === 'department') {
      analysis.departmentSuggestion = null;
    } else {
      delete analysis.fieldSuggestions[input.key];
    }
    await this.prisma.ticket.update({ where: { id: ticketId }, data: { analysis: json(analysis) } });
  }

  private async findQuestion(workspaceId: string, ticketId: string, questionId: string): Promise<AgentQuestion> {
    const question = await this.prisma.agentQuestion.findFirst({ where: { id: questionId, ticketId, workspaceId, status: 'open' } });
    if (question === null) throw errors.notFound(t('api.questionNotFound'));
    return question;
  }
}

function toQuestionDto(question: AgentQuestion): AgentQuestionDto {
  return { id: question.id, text: question.text, status: question.status, runId: question.runId, createdAt: question.createdAt.toISOString() };
}

