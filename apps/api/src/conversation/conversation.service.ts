import { t } from '@kvitok/i18n';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { CreateAgentMessageInput, CreateReplyInput, MessageDto } from '@kvitok/shared';
import { emailConfig, mailboxDomain } from '../channels/channel-config';
import { AppError, errors } from '../common/errors';
import { newId } from '../common/ids';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { AgentTriggerService } from '../agent/agent-trigger.service';
import { FieldsService } from '../fields/fields.service';
import type { Delivery } from '../generated/prisma/client';
import { htmlToPlainText, sanitizeOperatorHtml, textToHtml } from '../mail/html';
import { outboundMessageId, replySubject, threadHeaders } from '../mail/threading';
import { OutboundService, ticketWebhookRef } from '../outbound/outbound.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { recordEvent, type Actor } from '../tickets/ticket-events';
import { fieldState, MESSAGE_INCLUDE, toMessageDto } from '../tickets/tickets.mapper';
import { missingRequiredFields, TicketsService } from '../tickets/tickets.service';

/** Several messages to the agent in a row — one run. */
const OPERATOR_MESSAGE_DELAY_MS = 3000;

type ReplyInput = Omit<CreateReplyInput, 'cc' | 'statusAfter' | 'force'> & {
  cc: string[];
  statusAfter: 'pending' | 'resolved' | null;
  force: boolean;
};

@Injectable()
export class ConversationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tickets: TicketsService,
    private readonly fields: FieldsService,
    private readonly outbound: OutboundService,
    private readonly realtime: RealtimeService,
    private readonly agent: AgentTriggerService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** An operator's message to the agent: visible to the team only and always wakes the agent (except an answer to a question — AgentService queues that trigger). */
  async addAgentMessage(
    workspaceId: string,
    ticketId: string,
    userId: string,
    input: CreateAgentMessageInput,
    options: { answersQuestionId?: string } = {},
  ): Promise<MessageDto> {
    await this.tickets.get(workspaceId, ticketId);
    const message = await this.prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          id: newId(),
          workspaceId,
          ticketId,
          authorType: 'operator',
          authorUserId: userId,
          visibility: 'internal',
          source: 'ui',
          bodyText: input.body,
          bodyHtml: textToHtml(input.body),
          answersQuestionId: options.answersQuestionId ?? null,
        },
        include: MESSAGE_INCLUDE,
      });
      // A message to the agent is input for the agent.
      await tx.ticket.update({ where: { id: ticketId }, data: { revision: { increment: 1 } } });
      return created;
    });

    await this.realtime.publish(workspaceId, { type: 'message.created', ticketId, messageId: message.id });
    if (!options.answersQuestionId) {
      await this.agent.trigger(ticketId, { type: 'operator_message', messageId: message.id, userId }, { mode: 'refine', delay: OPERATOR_MESSAGE_DELAY_MS });
    }
    return toMessageDto(message);
  }

  async reply(workspaceId: string, ticketId: string, userId: string, input: ReplyInput): Promise<MessageDto> {
    const actor: Actor = { type: 'user', id: userId };
    const ticket = await this.tickets.get(workspaceId, ticketId);
    const workspace = await this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    const options = await this.tickets.replyOptions(ticket, workspace);
    const viaEmail = input.via.includes('email');
    const viaSource = input.via.includes('source');

    if (viaEmail && options.email === null) {
      throw errors.validation([{ path: 'via', message: t('api.noReplyMailbox'), code: 'custom' }]);
    }
    if (viaSource && !options.source) {
      throw errors.validation([{ path: 'via', message: t('api.sourceHasNoWebhook'), code: 'custom' }]);
    }

    if (input.lastSeenMessageId && !input.force) {
      await this.assertNoNewCustomerMessages(ticketId, input.lastSeenMessageId);
    }

    if (input.statusAfter === 'resolved') {
      const missing = missingRequiredFields(await this.fields.list(workspaceId, 'ticket'), fieldState(ticket).values, ticket.departmentId);
      if (missing.length > 0) {
        throw errors.validation(
          missing.map((d) => ({ path: `fields.${d.key}`, message: t('api.fillField', { label: d.label }), code: 'required_field' })),
          t('api.requiredFieldsBeforeResolve'),
        );
      }
    }

    const participants = await this.prisma.participant.findMany({ where: { ticketId } });
    const to = input.to ?? participants.filter((p) => p.role === 'customer').map((p) => p.email);
    if (viaEmail && to.length === 0) {
      throw errors.validation([{ path: 'to', message: t('api.customerAddressMissing'), code: 'custom' }]);
    }

    const mailbox = viaEmail ? await this.prisma.channel.findUniqueOrThrow({ where: { id: options.email!.mailboxId } }) : null;
    const mailboxConfig = mailbox ? emailConfig(mailbox) : null;
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    const bodyHtml = sanitizeOperatorHtml(input.bodyHtml) + (mailboxConfig?.signatureHtml ? `<br><br>${sanitizeOperatorHtml(mailboxConfig.signatureHtml)}` : '');
    const bodyText = input.bodyText?.trim() || htmlToPlainText(bodyHtml);
    const scheduledAt = new Date(Date.now() + this.config.replyUndoSeconds * 1000);
    const deliveries: Delivery[] = [];

    const message = await this.prisma.$transaction(async (tx) => {
      const id = newId();
      const thread = viaEmail
        ? threadHeaders(await tx.message.findMany({ where: { ticketId }, select: { rfcMessageId: true, authorType: true, createdAt: true } }))
        : { inReplyTo: null, references: [] };
      const rfcMessageId = mailboxConfig ? outboundMessageId(ticket.number, id, mailboxDomain(mailboxConfig.address)) : null;

      await tx.message.create({
        data: {
          id,
          workspaceId,
          ticketId,
          channelId: mailbox?.id ?? null,
          authorType: 'operator',
          authorUserId: userId,
          visibility: 'public',
          source: 'ui',
          subject: viaEmail ? replySubject(ticket.subject, ticket.number) : null,
          bodyText,
          bodyHtml,
          fromEmail: mailboxConfig?.address ?? null,
          fromName: mailboxConfig?.displayName || user.name,
          to: viaEmail ? to : [],
          cc: viaEmail ? input.cc : [],
          rfcMessageId,
          inReplyTo: thread.inReplyTo,
          references: rfcMessageId ? [...thread.references] : [],
        },
      });

      if (mailbox) {
        deliveries.push(
          await tx.delivery.create({
            data: { id: newId(), workspaceId, ticketId, messageId: id, channelId: mailbox.id, kind: 'email', scheduledAt },
          }),
        );
      }
      if (viaSource) {
        const webhook = await this.outbound.createSourceWebhook(
          tx,
          ticket,
          'message.created',
          {
            ticket: { ...ticketWebhookRef(ticket), status: input.statusAfter ?? (ticket.status === 'new' ? 'open' : ticket.status) },
            message: { id, body_text: bodyText, body_html: bodyHtml, author: { name: user.name }, created_at: new Date().toISOString() },
          },
          { messageId: id, scheduledAt },
        );
        if (webhook) {
          deliveries.push(webhook);
        }
      }

      // A ticket without the customer's address (API, phone): the address the operator entered becomes the customer's address,
      // so the next reply and the customer's reply via the [#T-n] token recognize it.
      const newCustomers = viaEmail && !participants.some((p) => p.role === 'customer') ? to : [];
      const added = [
        ...newCustomers.map((email) => ({ email, role: 'customer' as const })),
        ...(viaEmail ? input.cc : []).map((email) => ({ email, role: 'cc' as const })),
      ];
      for (const { email, role } of added) {
        await tx.participant.upsert({
          where: { ticketId_email: { ticketId, email } },
          update: {},
          create: { ticketId, email, role },
        });
      }

      // A sent reply closes the current draft; the version the agent suggested is no longer needed.
      await tx.replyDraft.updateMany({ where: { ticketId, status: 'current' }, data: { status: 'sent' } });
      await tx.replyDraft.updateMany({ where: { ticketId, status: 'suggested' }, data: { status: 'superseded' } });

      const nextStatus = input.statusAfter ?? (ticket.status === 'new' ? 'open' : ticket.status);
      if (nextStatus !== ticket.status) {
        await recordEvent(tx, { workspaceId, ticketId, type: 'status_changed', actor, data: { from: ticket.status, to: nextStatus } });
      }
      await tx.ticket.update({
        where: { id: ticketId },
        data: {
          status: nextStatus,
          revision: { increment: 1 },
          ...(ticket.firstResponseAt ? {} : { firstResponseAt: new Date() }),
          ...(nextStatus === 'resolved' ? { resolvedAt: new Date() } : {}),
        },
      });

      return tx.message.findUniqueOrThrow({ where: { id }, include: MESSAGE_INCLUDE });
    });

    await this.outbound.schedule(deliveries);
    await this.realtime.publish(workspaceId, { type: 'message.created', ticketId, messageId: message.id });
    await this.realtime.publish(workspaceId, { type: 'ticket.updated', ticketId });
    return toMessageDto(message);
  }

  /** Cancel within the "undo send" window: while no delivery has started. */
  async cancelReply(workspaceId: string, ticketId: string, messageId: string, userId: string): Promise<MessageDto> {
    const message = await this.prisma.message.findFirst({
      where: { id: messageId, ticketId, workspaceId, authorType: 'operator', visibility: 'public' },
      include: { deliveries: true },
    });
    if (message === null) {
      throw errors.notFound(t('api.messageNotFound'));
    }
    if (message.deliveries.some((d) => d.status !== 'queued' && d.status !== 'cancelled')) {
      throw new AppError(HttpStatus.CONFLICT, 'too_late', t('api.replyAlreadySending'));
    }

    const ids = message.deliveries.filter((d) => d.status === 'queued').map((d) => d.id);
    const cancelled = await this.prisma.delivery.updateMany({ where: { id: { in: ids }, status: 'queued' }, data: { status: 'cancelled' } });
    if (cancelled.count !== ids.length) {
      throw new AppError(HttpStatus.CONFLICT, 'too_late', t('api.replyAlreadySending'));
    }
    await this.outbound.cancel(ids);
    await this.prisma.$transaction((tx) =>
      recordEvent(tx, { workspaceId, ticketId, type: 'reply_cancelled', actor: { type: 'user', id: userId }, data: { messageId } }),
    );

    await this.realtime.publish(workspaceId, { type: 'ticket.updated', ticketId });
    return toMessageDto(await this.prisma.message.findUniqueOrThrow({ where: { id: messageId }, include: MESSAGE_INCLUDE }));
  }

  private async assertNoNewCustomerMessages(ticketId: string, lastSeenMessageId: string): Promise<void> {
    const lastSeen = await this.prisma.message.findFirst({ where: { id: lastSeenMessageId, ticketId } });
    if (lastSeen === null) {
      return;
    }
    const newer = await this.prisma.message.count({
      where: { ticketId, authorType: 'customer', isAutomated: false, createdAt: { gt: lastSeen.createdAt } },
    });
    if (newer > 0) {
      throw new AppError(
        HttpStatus.CONFLICT,
        'stale_conversation',
        t('api.staleConversation'),
        { newMessages: newer },
      );
    }
  }
}
