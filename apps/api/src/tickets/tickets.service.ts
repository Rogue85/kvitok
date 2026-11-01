import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import {
  isEmptyFieldValue,
  fieldValueSchema,
  type FieldDefinitionDto,
  type TicketDto,
  type TicketListDto,
  type TicketListQuery,
  type TimelineItemDto,
  type UpdateTicketInput,
} from '@kvitok/shared';
import { emailConfig } from '../channels/channel-config';
import { errors } from '../common/errors';
import { json } from '../common/json';
import { toCustomerDto } from '../customers/customers.service';
import { DepartmentsService } from '../departments/departments.service';
import { applyFieldValues } from '../fields/field-values';
import { FieldsService } from '../fields/fields.service';
import type { Channel, Delivery, Prisma, Ticket, Workspace } from '../generated/prisma/client';
import { OutboundService, ticketWebhookRef } from '../outbound/outbound.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { recordEvent, type Actor } from './ticket-events';
import {
  fieldState,
  MESSAGE_INCLUDE,
  TICKET_DETAIL_INCLUDE,
  TICKET_LIST_INCLUDE,
  toEventDto,
  toMessageDto,
  toTicketListItem,
} from './tickets.mapper';

@Injectable()
export class TicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fields: FieldsService,
    private readonly departments: DepartmentsService,
    private readonly outbound: OutboundService,
    private readonly realtime: RealtimeService,
  ) {}

  async list(workspaceId: string, query: TicketListQuery, currentUserId: string): Promise<TicketListDto> {
    const where: Prisma.TicketWhereInput = { workspaceId };
    const and: Prisma.TicketWhereInput[] = [];

    if (query.status?.length) {
      where.status = { in: query.status };
    }
    if (query.departmentId) {
      where.departmentId = query.departmentId === 'none' ? null : query.departmentId;
    }
    if (query.assignee) {
      where.assigneeId = query.assignee === 'none' ? null : query.assignee === 'me' ? currentUserId : query.assignee;
    }
    if (query.q) {
      const q = query.q.replace(/^#?T-/i, '');
      and.push({
        OR: [
          { subject: { contains: query.q, mode: 'insensitive' } },
          ...(/^\d+$/.test(q) ? [{ number: Number(q) }] : []),
          { customer: { name: { contains: query.q, mode: 'insensitive' } } },
          { customer: { identities: { some: { value: { contains: query.q.toLowerCase() } } } } },
        ],
      });
    }
    if (query.fields && Object.keys(query.fields).length > 0) {
      const definitions = new Map((await this.fields.list(workspaceId, 'ticket')).map((d) => [d.key, d]));
      for (const [key, raw] of Object.entries(query.fields)) {
        const definition = definitions.get(key);
        if (definition === undefined) {
          throw errors.validation([{ path: `field.${key}`, message: t('api.unknownField'), code: 'custom' }]);
        }
        and.push(fieldFilter(definition, raw));
      }
    }
    if (and.length > 0) {
      where.AND = and;
    }

    const [items, total] = await Promise.all([
      this.prisma.ticket.findMany({
        where,
        include: TICKET_LIST_INCLUDE,
        orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.ticket.count({ where }),
    ]);

    return { items: items.map(toTicketListItem), total, page: query.page, pageSize: query.pageSize };
  }

  async get(workspaceId: string, id: string): Promise<Ticket & { channel: Channel | null }> {
    const ticket = await this.prisma.ticket.findFirst({ where: { id, workspaceId }, include: { channel: true } });
    if (ticket === null) {
      throw errors.notFound(t('api.ticketNotFound'));
    }
    return ticket;
  }

  async getDetail(workspaceId: string, id: string): Promise<TicketDto> {
    const [ticket, workspace] = await Promise.all([
      this.prisma.ticket.findFirst({ where: { id, workspaceId }, include: TICKET_DETAIL_INCLUDE }),
      this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } }),
    ]);
    if (ticket === null) {
      throw errors.notFound(t('api.ticketNotFound'));
    }

    const listItem = toTicketListItem(ticket);
    return {
      ...listItem,
      customer: ticket.customer ? toCustomerDto(ticket.customer) : null,
      departmentLocked: ticket.departmentLocked,
      fieldMeta: fieldState(ticket).meta,
      revision: ticket.revision,
      participants: ticket.participants.map((p) => ({ email: p.email, name: p.name, role: p.role })),
      replyOptions: await this.replyOptions(ticket, workspace),
    };
  }

  async timeline(workspaceId: string, id: string): Promise<TimelineItemDto[]> {
    await this.get(workspaceId, id);
    const [messages, events] = await Promise.all([
      this.prisma.message.findMany({ where: { ticketId: id }, include: MESSAGE_INCLUDE, orderBy: { createdAt: 'asc' } }),
      this.prisma.ticketEvent.findMany({ where: { ticketId: id }, orderBy: { createdAt: 'asc' } }),
    ]);
    const userIds = [...new Set(events.filter((e) => e.actorType === 'user' && e.actorId).map((e) => e.actorId!))];
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: userIds } } })).map((u) => [u.id, u]));

    const items: TimelineItemDto[] = [
      ...messages.map((m) => ({ kind: 'message' as const, at: m.createdAt.toISOString(), message: toMessageDto(m) })),
      ...events.map((e) => ({ kind: 'event' as const, at: e.createdAt.toISOString(), event: toEventDto(e, users) })),
    ];
    return items.sort((a, b) => a.at.localeCompare(b.at) || timelineRank(a) - timelineRank(b));
  }

  async update(workspaceId: string, id: string, input: UpdateTicketInput, userId: string): Promise<TicketDto> {
    const actor: Actor = { type: 'user', id: userId };
    const ticket = await this.get(workspaceId, id);

    if (input.departmentId) {
      await this.departments.assertAssignable(workspaceId, input.departmentId);
    }
    if (input.assigneeId) {
      const membership = await this.prisma.membership.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: input.assigneeId } },
        include: { user: true },
      });
      if (membership === null || membership.role === 'viewer') {
        throw errors.validation([{ path: 'assigneeId', message: t('api.assigneeMustBeOperator'), code: 'custom' }]);
      }
      if (membership.user.disabledAt !== null) {
        throw errors.validation([{ path: 'assigneeId', message: t('api.assigneeDisabled'), code: 'custom' }]);
      }
    }

    const definitions = await this.fields.list(workspaceId, 'ticket');
    let fieldResult: ReturnType<typeof applyFieldValues> | null = null;
    if (input.fields) {
      const state = fieldState(ticket);
      fieldResult = applyFieldValues({
        definitions,
        values: state.values,
        meta: state.meta,
        input: input.fields,
        source: 'operator',
        actor: { userId },
      });
      if (fieldResult.rejected.length > 0) {
        throw errors.validation(fieldResult.rejected.map((r) => ({ path: `fields.${r.key}`, message: r.reason, code: 'custom' })));
      }
    }

    if ((input.status === 'resolved' || input.status === 'closed') && ticket.status !== input.status) {
      const missing = missingRequiredFields(definitions, fieldResult?.values ?? fieldState(ticket).values, input.departmentId ?? ticket.departmentId);
      if (missing.length > 0) {
        throw errors.validation(
          missing.map((d) => ({ path: `fields.${d.key}`, message: t('api.fillField', { label: d.label }), code: 'required_field' })),
          t('api.requiredFieldsBeforeResolve'),
        );
      }
    }

    const deliveries: Delivery[] = [];
    await this.prisma.$transaction(async (tx) => {
      const data: Prisma.TicketUpdateInput = {};
      let agentInputChanged = false;
      const event = (type: string, eventData: Record<string, unknown>) =>
        recordEvent(tx, { workspaceId, ticketId: id, type, actor, data: eventData });

      if (input.subject !== undefined && input.subject !== ticket.subject) {
        data.subject = input.subject;
        await event('subject_changed', { from: ticket.subject, to: input.subject });
      }
      if (input.status !== undefined && input.status !== ticket.status) {
        data.status = input.status;
        data.resolvedAt = input.status === 'resolved' || input.status === 'closed' ? new Date() : null;
        await event('status_changed', { from: ticket.status, to: input.status });
        const webhook = await this.outbound.createSourceWebhook(tx, ticket, 'ticket.status_changed', {
          ticket: { ...ticketWebhookRef(ticket), status: input.status },
          previous_status: ticket.status,
        });
        if (webhook) {
          deliveries.push(webhook);
        }
      }
      if (input.priority !== undefined && input.priority !== ticket.priority) {
        data.priority = input.priority;
        await event('priority_changed', { from: ticket.priority, to: input.priority });
      }
      if (input.departmentId !== undefined && input.departmentId !== ticket.departmentId) {
        data.department = input.departmentId ? { connect: { id: input.departmentId } } : { disconnect: true };
        data.departmentLocked = true;
        agentInputChanged = true;
        await event('department_changed', { from: ticket.departmentId, to: input.departmentId });
      }
      if (input.assigneeId !== undefined && input.assigneeId !== ticket.assigneeId) {
        data.assignee = input.assigneeId ? { connect: { id: input.assigneeId } } : { disconnect: true };
        await event('assignee_changed', { from: ticket.assigneeId, to: input.assigneeId });
      }
      if (input.tags !== undefined) {
        const tags = [...new Set(input.tags)];
        const added = tags.filter((t) => !ticket.tags.includes(t));
        const removed = ticket.tags.filter((t) => !tags.includes(t));
        if (added.length > 0 || removed.length > 0) {
          data.tags = tags;
          await event('tags_changed', { added, removed });
        }
      }
      if (fieldResult !== null) {
        data.fields = json(fieldResult.values);
        data.fieldMeta = json(fieldResult.meta);
        for (const change of fieldResult.changes) {
          await event('field_changed', { key: change.key, old: change.old, new: change.new, source: 'operator' });
        }
        agentInputChanged ||= fieldResult.changes.length > 0;
      }
      if (agentInputChanged) {
        data.revision = { increment: 1 };
      }

      if (Object.keys(data).length > 0) {
        await tx.ticket.update({ where: { id }, data });
      }
    });

    await this.outbound.schedule(deliveries);
    await this.realtime.publish(workspaceId, { type: 'ticket.updated', ticketId: id });
    return this.getDetail(workspaceId, id);
  }

  async replyOptions(
    ticket: Ticket & { channel: Channel | null },
    workspace: Pick<Workspace, 'defaultMailboxId'>,
  ): Promise<TicketDto['replyOptions']> {
    let mailbox: Channel | null = null;
    if (ticket.channel?.type === 'email' && ticket.channel.enabled) {
      mailbox = ticket.channel;
    } else if (workspace.defaultMailboxId) {
      mailbox = await this.prisma.channel.findFirst({
        where: { id: workspace.defaultMailboxId, workspaceId: ticket.workspaceId, type: 'email', enabled: true },
      });
    }

    const source =
      ticket.channel?.type === 'api' && ticket.channel.enabled && Boolean((ticket.channel.config as { webhookUrl?: string }).webhookUrl);

    return {
      email: mailbox ? { mailboxId: mailbox.id, address: emailConfig(mailbox).address } : null,
      source,
    };
  }

  /** Atomically hands out the next ticket number in the workspace. */
  async nextNumber(tx: Prisma.TransactionClient, workspaceId: string): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ ticket_seq: number }>>`
      UPDATE workspaces SET ticket_seq = ticket_seq + 1 WHERE id = ${workspaceId} RETURNING ticket_seq`;
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }
    return row.ticket_seq;
  }
}

/** With equal times (one transaction): ticket creation first, then messages, then their consequences. */
function timelineRank(item: TimelineItemDto): number {
  if (item.kind === 'message') return 1;
  return item.event.type === 'ticket_created' ? 0 : 2;
}

export function missingRequiredFields(
  definitions: FieldDefinitionDto[],
  values: Record<string, unknown>,
  departmentId: string | null,
): FieldDefinitionDto[] {
  return definitions.filter(
    (d) =>
      !d.archived &&
      d.requiredOn.includes('resolve') &&
      (d.scopeDepartmentIds.length === 0 || (departmentId !== null && d.scopeDepartmentIds.includes(departmentId))) &&
      isEmptyFieldValue(values[d.key]),
  );
}

function fieldFilter(definition: FieldDefinitionDto, raw: string): Prisma.TicketWhereInput {
  if (definition.type === 'multiselect') {
    return { fields: { path: [definition.key], array_contains: [raw] } };
  }
  const parsed = fieldValueSchema(definition).safeParse(raw);
  if (!parsed.success) {
    throw errors.validation([{ path: `field.${definition.key}`, message: t('api.invalidFilterValue'), code: 'custom' }]);
  }
  return { fields: { path: [definition.key], equals: json(parsed.data) } };
}
