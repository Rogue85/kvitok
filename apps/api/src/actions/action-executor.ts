import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import { IntegrationError, type ExecutionContext } from '@kvitok/protocol';
import { json } from '../common/json';
import type { ActionProposal, Integration } from '../generated/prisma/client';
import { AgentTriggerService } from '../agent/agent-trigger.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { recordEvent, SYSTEM_ACTOR } from '../tickets/ticket-events';

/** The execution outcome is unknown — the queue retries with the same idempotency key. */
export class ActionOutcomeUnknownError extends Error {}

type Outcome = { result?: unknown; external_ref?: string; error?: string };

/**
 * Executes an approved action in the backend. If the response was lost (timeout, network, 5xx),
 * asks for the status by key: executed/failed — the outcome is known, pending or unknown — retry later.
 */
@Injectable()
export class ActionExecutor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
    private readonly realtime: RealtimeService,
    private readonly triggers: AgentTriggerService,
  ) {}

  async execute(proposalId: string): Promise<'executed' | 'failed' | 'skipped'> {
    const proposal = await this.prisma.actionProposal.findUnique({
      where: { id: proposalId },
      include: { integration: true, ticket: { select: { number: true } }, decidedBy: { select: { email: true } } },
    });
    if (!proposal || !['approved', 'executing'].includes(proposal.status)) return 'skipped';
    await this.prisma.actionProposal.update({ where: { id: proposalId }, data: { status: 'executing', attempts: { increment: 1 } } });

    const client = this.integrations.client(proposal.integration);
    const key = proposal.idempotencyKey ?? proposal.id;
    const params = (proposal.normalizedParams ?? proposal.params) as Record<string, unknown>;
    try {
      // Who started it, for the backend's audit: the operator is the one who pressed "Execute" (approved the proposal).
      const context: ExecutionContext = {
        source: proposal.source === 'operator' ? 'operator' : 'agent',
        ticket: `T-${proposal.ticket.number}`,
        ...(proposal.decidedBy ? { operator: { email: proposal.decidedBy.email } } : {}),
      };
      const response = await client.execute(proposal.action, proposal.customerRef, params, key, context);
      return this.finish(proposal, response.status, response);
    } catch (error) {
      if (error instanceof IntegrationError && !error.retryable) {
        return this.finish(proposal, 'failed', { error: `${error.code}: ${error.message}` });
      }
      // The response was lost — ask the backend how it ended. A failure here too means retry later.
      const status = await client.executionStatus(key);
      if (status.status === 'executed' || status.status === 'failed') {
        return this.finish(proposal, status.status, status);
      }
      throw new ActionOutcomeUnknownError(
        status.status === 'pending' ? t('api.action.stillExecuting') : t('api.action.requestFailed', { error: error instanceof Error ? error.message : String(error) }),
      );
    }
  }

  /** Attempts are exhausted and the outcome was never confirmed. An operator retry is safe: the key is the same. */
  async giveUp(proposalId: string, reason: string): Promise<void> {
    const proposal = await this.prisma.actionProposal.findUnique({ where: { id: proposalId }, include: { integration: true } });
    if (!proposal || proposal.status !== 'executing') return;
    await this.finish(proposal, 'failed', { error: t('api.action.outcomeUnknown', { reason }) });
  }

  private async finish(proposal: ActionProposal & { integration: Integration }, status: 'executed' | 'failed', outcome: Outcome): Promise<'executed' | 'failed'> {
    await this.prisma.$transaction(async (tx) => {
      await tx.actionProposal.update({
        where: { id: proposal.id },
        data: {
          status,
          result: outcome.result === undefined ? undefined : json(outcome.result),
          externalRef: outcome.external_ref ?? null,
          error: status === 'failed' ? (outcome.error ?? t('api.action.notExecuted')).slice(0, 2000) : null,
          executedAt: new Date(),
        },
      });
      await recordEvent(tx, {
        workspaceId: proposal.workspaceId,
        ticketId: proposal.ticketId,
        type: status === 'executed' ? 'action_executed' : 'action_failed',
        actor: SYSTEM_ACTOR,
        data: { proposalId: proposal.id, title: proposal.title, preview: proposal.preview, externalRef: outcome.external_ref ?? null, error: outcome.error ?? null },
      });
    });
    await this.realtime.publish(proposal.workspaceId, { type: 'ticket.updated', ticketId: proposal.ticketId });
    // An operator's action asked to update the reply: the draft may promise the opposite of what was done.
    if (proposal.source === 'operator' && proposal.refreshDraft) {
      await this.triggers.trigger(
        proposal.ticketId,
        { type: 'action_executed', actionId: proposal.id, ...(proposal.decidedById ? { userId: proposal.decidedById } : {}) },
        { mode: 'refine' },
      );
    }
    return status;
  }
}
