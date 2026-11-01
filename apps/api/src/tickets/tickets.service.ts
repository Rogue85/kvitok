import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import {
  BULK_TICKETS_LIMIT,
  TICKET_STATUSES,
  isEmptyFieldValue,
  fieldValueSchema,
  type BulkTicketChangesSchema,
  type ApiErrorBody,
  type BulkUpdateTicketsResultDto,
  type FieldDefinitionDto,
  type TicketCountsDto,
  type TicketDto,
  type TicketListDto,
  type TicketListQuery,
  type TimelineItemDto,
  type UpdateTicketInput,
} from '@kvitok/shared';
import type { z } from 'zod';
import { emailConfig } from '../channels/channel-config';
import { AppError, errors } from '../common/errors';
import { json } from '../common/json';
import { toCustomerDto } from '../customers/customers.service';
import { DepartmentsService } from '../departments/departments.service';
import { applyFieldValues } from '../fields/field-values';
import { FieldsService } from '../fields/fields.service';
import { Prisma, type Channel, type Delivery, type Ticket, type Workspace } from '../generated/prisma/client';
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
    const where = await this.listWhere(workspaceId, query, currentUserId);
    const [items, total] = await Promise.all([
      this.prisma.ticket.findMany({
        where,
        include: TICKET_LIST_INCLUDE,
        orderBy: LIST_ORDER[query.sort],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.ticket.count({ where }),
    ]);
    const attention = new Set(
      (
        await this.prisma.ticket.findMany({
          where: { id: { in: items.map((i) => i.id) }, ...ATTENTION_WHERE },
          select: { id: true },
        })
      ).map((r) => r.id),
    );

    return {
      items: items.map((i) => ({ ...toTicketListItem(i), attention: attention.has(i.id) })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async counts(workspaceId: string, query: TicketListQuery, currentUserId: string): Promise<TicketCountsDto> {
    const where = await this.listWhere(workspaceId, { ...query, status: undefined }, currentUserId);
    const rows = await this.prisma.ticket.groupBy({ by: ['status'], where, _count: { _all: true } });
    return Object.fromEntries(
      TICKET_STATUSES.map((status) => [status, rows.find((r) => r.status === status)?._count._all ?? 0]),
    ) as TicketCountsDto;
  }

  /** Distinct tags of the workspace's tickets, the most used first. */
  async tags(workspaceId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ tag: string }>>`
      SELECT tag FROM tickets, unnest(tags) AS tag WHERE workspace_id = ${workspaceId}
      GROUP BY tag ORDER BY count(*) DESC, tag LIMIT 500`;
    return rows.map((r) => r.tag);
  }

  private async listWhere(workspaceId: string, query: TicketListQuery, currentUserId: string): Promise<Prisma.TicketWhereInput> {
    const and: Prisma.TicketWhereInput[] = [{ workspaceId }];
    /** A list with `none` matches an empty value too. */
    const anyOf = <K extends 'departmentId' | 'assigneeId'>(key: K, values: string[]): Prisma.TicketWhereInput => {
      const ids = values.filter((v) => v !== 'none');
      return {
        OR: [...(ids.length > 0 ? [{ [key]: { in: ids } }] : []), ...(values.includes('none') ? [{ [key]: null }] : [])],
      };
    };

    if (query.status?.length) {
      and.push({ status: { in: query.status } });
    }
    if (query.priority?.length) {
      and.push({ priority: { in: query.priority } });
    }
    if (query.departmentId?.length) {
      and.push(anyOf('departmentId', query.departmentId));
    }
    if (query.assignee?.length) {
      and.push(anyOf('assigneeId', query.assignee.map((a) => (a === 'me' ? currentUserId : a))));
    }
    if (query.channelId?.length) {
      and.push({ channelId: { in: query.channelId } });
    }
    if (query.tags?.length) {
      and.push({ tags: { hasSome: query.tags } });
    }
    if (query.agentState?.length) {
      and.push({ agentState: { in: query.agentState } });
    }
    if (query.attention) {
      and.push(ATTENTION_WHERE);
    }
    if (query.createdFrom || query.createdTo) {
      and.push({ createdAt: { gte: query.createdFrom, lt: query.createdTo } });
    }
    if (query.updatedFrom || query.updatedTo) {
      and.push({ lastMessageAt: { gte: query.updatedFrom, lt: query.updatedTo } });
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
    return { AND: and };
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
    const ticket = await this.get(workspaceId, id);
    await this.assertTargets(workspaceId, input);
    await this.apply(ticket, input, userId, await this.fields.list(workspaceId, 'ticket'));
    return this.getDetail(workspaceId, id);
  }

  /**
   * One change for many tickets, each through the same path as a single update: events, webhooks and the
   * required fields check. A ticket that refuses the change does not stop the others.
   */
  async bulkUpdate(
    workspaceId: string,
    target: { ids: string[] } | { filter: TicketListQuery },
    changes: z.infer<typeof BulkTicketChangesSchema>,
    userId: string,
  ): Promise<BulkUpdateTicketsResultDto> {
    const where =
      'ids' in target ? { workspaceId, id: { in: target.ids } } : await this.listWhere(workspaceId, target.filter, userId);
    const tickets = await this.prisma.ticket.findMany({
      where,
      include: { channel: true },
      orderBy: { number: 'asc' },
      take: BULK_TICKETS_LIMIT + 1,
    });
    if (tickets.length > BULK_TICKETS_LIMIT) {
      throw errors.validation([], t('api.bulkTooMany', { limit: BULK_TICKETS_LIMIT }));
    }
    const { addTags, removeTags, ...input } = changes;
    await this.assertTargets(workspaceId, input);
    const definitions = await this.fields.list(workspaceId, 'ticket');

    const result: BulkUpdateTicketsResultDto = { updated: [], failed: [] };
    for (const ticket of tickets) {
      const tags =
        addTags || removeTags
          ? [...new Set([...ticket.tags, ...(addTags ?? [])])].filter((tag) => !removeTags?.includes(tag))
          : undefined;
      try {
        await this.apply(ticket, { ...input, ...(tags ? { tags } : {}) }, userId, definitions);
        result.updated.push(ticket.id);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        result.failed.push({ id: ticket.id, number: ticket.number, message: errorText(error) });
      }
    }
    return result;
  }

  /** The department and the assignee a change sets exist and can take tickets. */
  private async assertTargets(workspaceId: string, input: Pick<UpdateTicketInput, 'departmentId' | 'assigneeId'>): Promise<void> {
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
  }

  private async apply(
    ticket: Ticket & { channel: Channel | null },
    input: UpdateTicketInput,
    userId: string,
    definitions: FieldDefinitionDto[],
  ): Promise<void> {
    const { workspaceId, id } = ticket;
    const actor: Actor = { type: 'user', id: userId };
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

const LIST_ORDER: Record<TicketListQuery['sort'], Prisma.TicketOrderByWithRelationInput[]> = {
  updated: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
  oldest: [{ lastMessageAt: 'asc' }, { id: 'asc' }],
  created: [{ createdAt: 'desc' }, { id: 'desc' }],
  priority: [{ priority: 'desc' }, { lastMessageAt: 'desc' }, { id: 'desc' }],
};

/** Waits for the operator: an open question of the agent, a proposed action, a customer to confirm. */
const ATTENTION_WHERE: Prisma.TicketWhereInput = {
  OR: [
    { agentQuestions: { some: { status: 'open' } } },
    { actionProposals: { some: { status: 'proposed' } } },
    { customer: { links: { some: { pending: { not: Prisma.DbNull } } } } },
  ],
};

/** The error message with the details' messages, for a ticket that refused a bulk change. */
function errorText(error: AppError): string {
  const body = error.getResponse() as ApiErrorBody;
  const details = Array.isArray(body.error.details) ? (body.error.details as Array<{ message?: string }>) : [];
  return [body.error.message, ...details.map((d) => d.message).filter(Boolean)].join(': ');
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
