import { t } from '@kvitok/i18n';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { ActionProposalDto } from '@kvitok/shared';
import type { Queue } from 'bullmq';
import { errors } from '../common/errors';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { recordEvent } from '../tickets/ticket-events';
import { ACTION_INCLUDE, toActionDto } from './action-dto';
import { ACTIONS_QUEUE, EXECUTE_ATTEMPTS, EXECUTE_JOB, type ExecuteJobData } from './actions.constants';

/**
 * Operator decisions on proposed actions. Approval queues the execution,
 * rejection only records the reason. A decision changes the agent input: revision++, but does not start a run.
 */
@Injectable()
export class ActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    @InjectQueue(ACTIONS_QUEUE) private readonly queue: Queue<ExecuteJobData>,
  ) {}

  async listForTicket(ticketId: string): Promise<ActionProposalDto[]> {
    const rows = await this.prisma.actionProposal.findMany({ where: { ticketId }, include: ACTION_INCLUDE, orderBy: { createdAt: 'asc' } });
    return rows.map(toActionDto);
  }

  async approve(workspaceId: string, ticketId: string, id: string, userId: string, comment?: string): Promise<ActionProposalDto> {
    const row = await this.decide(workspaceId, ticketId, id, ['proposed'], async (tx, proposal) => {
      await tx.actionProposal.update({
        where: { id },
        // The key is the proposal id: the backend will not execute the same proposal twice.
        data: { status: 'approved', decidedById: userId, decidedAt: new Date(), decisionComment: comment || null, idempotencyKey: proposal.id },
      });
      return { type: 'action_approved', data: { proposalId: id, title: proposal.title, preview: proposal.preview, comment: comment || null } };
    }, userId);
    await this.enqueue(id);
    return row;
  }

  async reject(workspaceId: string, ticketId: string, id: string, userId: string, comment?: string): Promise<ActionProposalDto> {
    return this.decide(workspaceId, ticketId, id, ['proposed'], async (tx, proposal) => {
      await tx.actionProposal.update({ where: { id }, data: { status: 'rejected', decidedById: userId, decidedAt: new Date(), decisionComment: comment || null } });
      return { type: 'action_rejected', data: { proposalId: id, title: proposal.title, preview: proposal.preview, comment: comment || null } };
    }, userId);
  }

  /** A retry after an error uses the same idempotency key, so it is safe. */
  async retry(workspaceId: string, ticketId: string, id: string, userId: string): Promise<ActionProposalDto> {
    const row = await this.decide(workspaceId, ticketId, id, ['failed'], async (tx, proposal) => {
      await tx.actionProposal.update({ where: { id }, data: { status: 'approved', error: null } });
      return { type: 'action_retried', data: { proposalId: id, title: proposal.title } };
    }, userId, { bumpRevision: false });
    await this.enqueue(id);
    return row;
  }

  private async enqueue(id: string): Promise<void> {
    await this.queue.add(EXECUTE_JOB, { proposalId: id }, {
      jobId: `${EXECUTE_JOB}:${id}:${Date.now()}`,
      attempts: EXECUTE_ATTEMPTS,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    });
  }

  private async decide(
    workspaceId: string,
    ticketId: string,
    id: string,
    allowed: string[],
    change: (tx: Prisma.TransactionClient, proposal: { id: string; title: string; preview: string | null }) => Promise<{ type: string; data: Record<string, unknown> }>,
    userId: string,
    options: { bumpRevision?: boolean } = {},
  ): Promise<ActionProposalDto> {
    await this.prisma.$transaction(async (tx) => {
      // A double click or two operators: the decision is taken once.
      const [locked] = await tx.$queryRaw<Array<{ status: string; title: string; preview: string | null }>>`
        SELECT status, title, preview FROM action_proposals WHERE id = ${id} AND ticket_id = ${ticketId} AND workspace_id = ${workspaceId} FOR UPDATE`;
      if (!locked) throw errors.notFound(t('api.proposalNotFound'));
      if (!allowed.includes(locked.status)) throw errors.conflict(t('api.actionAlreadyInStatus', { status: locked.status }));
      const event = await change(tx, { id, title: locked.title, preview: locked.preview });
      if (options.bumpRevision !== false) {
        await tx.ticket.update({ where: { id: ticketId }, data: { revision: { increment: 1 } } });
      }
      await recordEvent(tx, { workspaceId, ticketId, type: event.type, actor: { type: 'user', id: userId }, data: event.data });
    });
    await this.realtime.publish(workspaceId, { type: 'ticket.updated', ticketId });
    const row = await this.prisma.actionProposal.findUniqueOrThrow({ where: { id }, include: ACTION_INCLUDE });
    return toActionDto(row);
  }
}
