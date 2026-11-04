import { t } from '@kvitok/i18n';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { ActionCatalogIntegration, ActionProposalDto, CreateActionInput } from '@kvitok/shared';
import { IntegrationError, type ValidateResponse } from '@kvitok/protocol';
import type { Queue } from 'bullmq';
import { errors } from '../common/errors';
import type { Prisma } from '../generated/prisma/client';
import { newId } from '../common/ids';
import { json } from '../common/json';
import { IntegrationsService, parseStoredManifest } from '../integrations/integrations.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { NotificationsService } from '../notifications/notifications.service';
import { markActive, publishAssigneeChanges } from '../tickets/assignment';
import { recordEvent } from '../tickets/ticket-events';
import { ACTION_INCLUDE, toActionDto } from './action-dto';
import { ACTIONS_QUEUE, EXECUTE_ATTEMPTS, EXECUTE_JOB, type ExecuteJobData } from './actions.constants';

/**
 * Operator decisions on proposed actions and manual actions of operators. Approval queues the execution,
 * rejection only records the reason. A decision changes the agent input: revision++, but does not start a run.
 * A manual action is a proposal with `source: operator`: it waits for "Execute" like the agent's ones, and executing it
 * rejects every other pending proposal of the ticket.
 */
@Injectable()
export class ActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
    private readonly integrations: IntegrationsService,
    @InjectQueue(ACTIONS_QUEUE) private readonly queue: Queue<ExecuteJobData>,
  ) {}

  async listForTicket(ticketId: string): Promise<ActionProposalDto[]> {
    const rows = await this.prisma.actionProposal.findMany({ where: { ticketId }, include: ACTION_INCLUDE, orderBy: { createdAt: 'asc' } });
    return rows.map(toActionDto);
  }

  /** What an operator can start by hand: the actions of the integrations the ticket's customer is found in. */
  async catalog(workspaceId: string, ticketId: string): Promise<ActionCatalogIntegration[]> {
    const ticket = await this.prisma.ticket.findFirst({ where: { id: ticketId, workspaceId }, select: { customerId: true } });
    if (!ticket) throw errors.notFound(t('api.ticketNotFound'));
    const rows = await this.prisma.integration.findMany({ where: { workspaceId, enabled: true }, orderBy: { createdAt: 'asc' } });
    const links = ticket.customerId ? await this.prisma.customerLink.findMany({ where: { customerId: ticket.customerId } }) : [];
    return rows.flatMap((row) => {
      const manifest = parseStoredManifest(row);
      const actions = manifest?.actions.filter((a) => a.audience.includes('operator')) ?? [];
      if (!manifest || actions.length === 0) return [];
      const link = links.find((l) => l.integrationId === row.id && l.status === 'found' && l.customerRef);
      return [
        {
          integrationId: row.id,
          title: row.name,
          customer: link ? { displayName: link.displayName, confirmed: link.confirmed } : null,
          blocked: !link ? ('no_customer' as const) : !link.confirmed ? ('not_confirmed' as const) : null,
          actions: actions.map((a) => ({
            name: a.name,
            title: a.title,
            description: a.description,
            operatorOnly: !a.audience.includes('agent'),
            inputSchema: a.input_schema,
            examples: a.examples,
          })),
        },
      ];
    });
  }

  /**
   * An operator proposes an action by hand: the backend validates it now, the card waits for "Execute".
   * Invalid parameters come back as a 422 with the backend's errors; nothing is stored. The revision does not grow:
   * nothing is decided yet.
   */
  async create(workspaceId: string, ticketId: string, userId: string, input: CreateActionInput): Promise<ActionProposalDto> {
    const ticket = await this.prisma.ticket.findFirst({ where: { id: ticketId, workspaceId }, select: { customerId: true } });
    if (!ticket) throw errors.notFound(t('api.ticketNotFound'));
    const integration = await this.prisma.integration.findFirst({ where: { id: input.integrationId, workspaceId, enabled: true } });
    const manifest = integration ? parseStoredManifest(integration) : null;
    const action = manifest?.actions.find((a) => a.name === input.action && a.audience.includes('operator'));
    if (!integration || !action) throw errors.validation({ errors: [] }, t('api.action.unknownAction', { action: input.action }));
    const link = ticket.customerId
      ? await this.prisma.customerLink.findUnique({ where: { customerId_integrationId: { customerId: ticket.customerId, integrationId: integration.id } } })
      : null;
    if (!link || link.status !== 'found' || !link.customerRef) throw errors.conflict(t('api.action.noCustomer'));
    if (!link.confirmed) throw errors.conflict(t('api.customerNotConfirmed'));

    let result: ValidateResponse;
    try {
      result = await this.integrations.client(integration).validate(action.name, link.customerRef, input.params);
    } catch (error) {
      // 422 of the backend: the parameters do not match input_schema.
      if (error instanceof IntegrationError && error.code === 'invalid_arguments') {
        throw errors.validation({ errors: [{ message: error.message }] }, t('api.action.invalidParams'));
      }
      throw errors.conflict(t('api.action.backendUnavailable', { error: error instanceof Error ? error.message : String(error) }));
    }
    if (!result.ok) throw errors.validation({ errors: result.errors }, t('api.action.invalidParams'));

    const customerRef = link.customerRef;
    const id = newId();
    const assignees = await this.prisma.$transaction(async (tx) => {
      if (input.replaces) {
        // Editing one's own pending card: the old one is superseded by the new one.
        const [old] = await tx.$queryRaw<Array<{ status: string; source: string; created_by_id: string | null }>>`
          SELECT status, source, created_by_id FROM action_proposals
          WHERE id = ${input.replaces} AND ticket_id = ${ticketId} AND workspace_id = ${workspaceId} FOR UPDATE`;
        if (!old || old.status !== 'proposed' || old.source !== 'operator') throw errors.conflict(t('api.action.notReplaceable'));
      }
      await tx.actionProposal.create({
        data: {
          id,
          workspaceId,
          ticketId,
          integrationId: integration.id,
          source: 'operator',
          createdById: userId,
          refreshDraft: input.refreshDraft,
          action: action.name,
          title: action.title,
          customerRef,
          params: json(input.params),
          normalizedParams: result.normalized_params ? json(result.normalized_params) : undefined,
          preview: result.preview ?? null,
          warnings: json(result.warnings),
          reason: input.reason,
        },
      });
      if (input.replaces) {
        await tx.actionProposal.update({ where: { id: input.replaces }, data: { status: 'superseded', replacedById: id } });
      }
      await recordEvent(tx, {
        workspaceId,
        ticketId,
        type: 'action_proposed_by_operator',
        actor: { type: 'user', id: userId },
        data: { proposalId: id, title: action.title, preview: result.preview ?? null, reason: input.reason, replaces: input.replaces ?? null },
      });
      return markActive(tx, workspaceId, ticketId, userId);
    });
    await publishAssigneeChanges(this.realtime, this.notifications, workspaceId, [assignees], userId);
    await this.realtime.publish(workspaceId, { type: 'ticket.updated', ticketId });
    const row = await this.prisma.actionProposal.findUniqueOrThrow({ where: { id }, include: ACTION_INCLUDE });
    return toActionDto(row);
  }

  /**
   * `pending` — for a manual action, the proposals the operator's confirmation listed as to be rejected. One of them
   * approved by a colleague in the meantime stops the approval: the operator was told it would not run.
   */
  async approve(workspaceId: string, ticketId: string, id: string, userId: string, comment?: string, pending?: string[]): Promise<ActionProposalDto> {
    const row = await this.decide(workspaceId, ticketId, id, ['proposed'], async (tx, proposal) => {
      if (proposal.source === 'operator' && pending && pending.length > 0) {
        const decided = await tx.actionProposal.findMany({
          where: { ticketId, id: { in: pending.filter((p) => p !== id) }, status: { in: ['approved', 'executing', 'executed', 'failed'] } },
          select: { title: true, preview: true },
        });
        if (decided.length > 0) {
          throw errors.conflict(t('api.action.approvedMeanwhile', { actions: decided.map((d) => d.preview ?? d.title).join('; ') }));
        }
      }
      await assertCustomerConfirmed(tx, id);
      await tx.actionProposal.update({
        where: { id },
        // The key is the proposal id: the backend will not execute the same proposal twice.
        data: { status: 'approved', decidedById: userId, decidedAt: new Date(), decisionComment: comment || null, idempotencyKey: proposal.id },
      });
      const replaced = proposal.source === 'operator' ? await rejectPending(tx, ticketId, id, userId) : [];
      return {
        type: 'action_approved',
        data: { proposalId: id, title: proposal.title, preview: proposal.preview, comment: comment || null, ...(replaced.length > 0 ? { replaced } : {}) },
      };
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
    change: (
      tx: Prisma.TransactionClient,
      proposal: { id: string; title: string; preview: string | null; source: string },
    ) => Promise<{ type: string; data: Record<string, unknown> }>,
    userId: string,
    options: { bumpRevision?: boolean } = {},
  ): Promise<ActionProposalDto> {
    const assignees = await this.prisma.$transaction(async (tx) => {
      // A double click or two operators: the decision is taken once. All pending proposals of the ticket are locked in one
      // order: a manual action executed first rejects the other proposal, and its approval then fails; the other way round
      // the manual action sees the proposal approved and stops if its confirmation promised to reject it (`pending`).
      await tx.$queryRaw`SELECT id FROM action_proposals WHERE ticket_id = ${ticketId} AND status = 'proposed' ORDER BY id FOR UPDATE`;
      const [locked] = await tx.$queryRaw<Array<{ status: string; title: string; preview: string | null; source: string }>>`
        SELECT status, title, preview, source FROM action_proposals WHERE id = ${id} AND ticket_id = ${ticketId} AND workspace_id = ${workspaceId} FOR UPDATE`;
      if (!locked) throw errors.notFound(t('api.proposalNotFound'));
      if (!allowed.includes(locked.status)) throw errors.conflict(t('api.actionAlreadyInStatus', { status: locked.status }));
      const event = await change(tx, { id, title: locked.title, preview: locked.preview, source: locked.source });
      if (options.bumpRevision !== false) {
        await tx.ticket.update({ where: { id: ticketId }, data: { revision: { increment: 1 } } });
      }
      await recordEvent(tx, { workspaceId, ticketId, type: event.type, actor: { type: 'user', id: userId }, data: event.data });
      return markActive(tx, workspaceId, ticketId, userId);
    });
    await publishAssigneeChanges(this.realtime, this.notifications, workspaceId, [assignees], userId);
    await this.realtime.publish(workspaceId, { type: 'ticket.updated', ticketId });
    const row = await this.prisma.actionProposal.findUniqueOrThrow({ where: { id }, include: ACTION_INCLUDE });
    return toActionDto(row);
  }
}

/**
 * Executing a manual action rejects every other pending proposal of the ticket, the agent's and the operators':
 * the operator saw them in the confirmation. If one was still needed, the agent is asked to propose it again.
 */
async function rejectPending(tx: Prisma.TransactionClient, ticketId: string, replacedById: string, userId: string): Promise<Array<{ id: string; title: string }>> {
  const pending = await tx.actionProposal.findMany({ where: { ticketId, status: 'proposed', id: { not: replacedById } }, select: { id: true, title: true } });
  if (pending.length === 0) return [];
  await tx.actionProposal.updateMany({
    where: { id: { in: pending.map((p) => p.id) }, status: 'proposed' },
    data: { status: 'rejected', replacedById, decidedById: userId, decidedAt: new Date() },
  });
  return pending;
}

/** A customer found only by data from the messages and not confirmed yet: their actions wait for the operator's confirmation. */
async function assertCustomerConfirmed(tx: Prisma.TransactionClient, proposalId: string): Promise<void> {
  const proposal = await tx.actionProposal.findUniqueOrThrow({ where: { id: proposalId }, select: { integrationId: true, ticket: { select: { customerId: true } } } });
  if (!proposal.ticket.customerId) return;
  const link = await tx.customerLink.findUnique({
    where: { customerId_integrationId: { customerId: proposal.ticket.customerId, integrationId: proposal.integrationId } },
    select: { status: true, confirmed: true },
  });
  if (link && !link.confirmed) {
    throw errors.conflict(t('api.customerNotConfirmed'));
  }
}
