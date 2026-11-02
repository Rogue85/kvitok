import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import {
  ALL_DEPARTMENTS,
  assignmentSettings,
  BULK_TICKETS_LIMIT,
  canSeeDepartment,
  MAX_TICKET_ASSIGNEES,
  TICKET_STATUSES,
  isEmptyFieldValue,
  fieldValueSchema,
  type BulkTicketChangesSchema,
  type ApiErrorBody,
  type BulkUpdateTicketsResultDto,
  type DepartmentScope,
  type FieldDefinitionDto,
  type TicketCountsDto,
  type TicketDto,
  type TicketListDto,
  type TicketListQuery,
  type TimelineItemDto,
  type UpdateTicketInput,
  type WorkspaceRole,
} from '@kvitok/shared';
import type { z } from 'zod';
import { emailConfig } from '../channels/channel-config';
import { AppError, errors } from '../common/errors';
import { json } from '../common/json';
import { toCustomerDto } from '../customers/customers.service';
import { MEMBERSHIP_DEPARTMENTS, membershipScope, systemAccess, ticketScopeWhere, type TicketAccess } from '../departments/department-access';
import { DepartmentsService } from '../departments/departments.service';
import { applyFieldValues } from '../fields/field-values';
import { FieldsService } from '../fields/fields.service';
import { Prisma, type Channel, type Delivery, type Ticket, type Workspace } from '../generated/prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { OutboundService, ticketWebhookRef } from '../outbound/outbound.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { addAssignees, fitsAssigneeLimit, lockTicketForAssignees, publishAssigneeChanges, removeAssignees, reopens, settleAssignees, type AssigneeChange } from './assignment';
import { recordDepartmentChange } from './department-change';
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
    private readonly notifications: NotificationsService,
  ) {}

  async list(access: TicketAccess, query: TicketListQuery, currentUserId: string): Promise<TicketListDto> {
    const where = await this.listWhere(access, query, currentUserId);
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

  async counts(access: TicketAccess, query: TicketListQuery, currentUserId: string): Promise<TicketCountsDto> {
    const where = await this.listWhere(access, { ...query, status: undefined }, currentUserId);
    const rows = await this.prisma.ticket.groupBy({ by: ['status'], where, _count: { _all: true } });
    return Object.fromEntries(
      TICKET_STATUSES.map((status) => [status, rows.find((r) => r.status === status)?._count._all ?? 0]),
    ) as TicketCountsDto;
  }

  /** Distinct tags of the tickets the caller may see, the most used first. */
  async tags(access: TicketAccess): Promise<string[]> {
    const { scope, assignedTo } = access;
    const departments = scope.all
      ? Prisma.empty
      : Prisma.sql`AND (department_id = ANY(${scope.departmentIds}::text[])${scope.unrouted ? Prisma.sql` OR department_id IS NULL` : Prisma.empty}${
          assignedTo !== null
            ? Prisma.sql` OR id IN (SELECT ticket_id FROM ticket_assignees WHERE workspace_id = ${access.workspaceId} AND user_id = ${assignedTo})`
            : Prisma.empty
        })`;
    const rows = await this.prisma.$queryRaw<Array<{ tag: string }>>`
      SELECT tag FROM tickets, unnest(tags) AS tag WHERE workspace_id = ${access.workspaceId} ${departments}
      GROUP BY tag ORDER BY count(*) DESC, tag LIMIT 500`;
    return rows.map((r) => r.tag);
  }

  /** The list's filters within the caller's departments: a filter by another department finds nothing. */
  private async listWhere(access: TicketAccess, query: TicketListQuery, currentUserId: string): Promise<Prisma.TicketWhereInput> {
    const { workspaceId } = access;
    const and: Prisma.TicketWhereInput[] = [{ workspaceId }, ticketScopeWhere(access)];
    /** A list with `none` matches an empty value too. */
    const anyOf = <K extends 'departmentId'>(key: K, values: string[]): Prisma.TicketWhereInput => {
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
      // Any of them is an assignee; `none` — the ticket has none.
      const ids = query.assignee.filter((a) => a !== 'none').map((a) => (a === 'me' ? currentUserId : a));
      and.push({
        OR: [
          ...(ids.length > 0 ? [{ assignees: { some: { userId: { in: ids } } } }] : []),
          ...(query.assignee.includes('none') ? [{ assignees: { none: {} } }] : []),
        ],
      });
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

  /**
   * A ticket of the workspace whatever the caller's departments: for system code and for routes with `:ticketId`,
   * which WorkspaceGuard has already checked against the caller's departments.
   */
  async get(workspaceId: string, id: string): Promise<Ticket & { channel: Channel | null }> {
    const ticket = await this.prisma.ticket.findFirst({ where: { id, workspaceId }, include: { channel: true } });
    if (ticket === null) {
      throw errors.notFound(t('api.ticketNotFound'));
    }
    return ticket;
  }

  /** A ticket the caller may see, or 404 as if it did not exist. */
  async visible(access: TicketAccess, id: string): Promise<Ticket & { channel: Channel | null }> {
    const ticket = await this.prisma.ticket.findFirst({
      where: { id, workspaceId: access.workspaceId, ...ticketScopeWhere(access) },
      include: { channel: true },
    });
    if (ticket === null) {
      throw errors.notFound(t('api.ticketNotFound'));
    }
    return ticket;
  }

  async getDetail(access: TicketAccess, id: string): Promise<TicketDto> {
    const { workspaceId } = access;
    const [ticket, workspace] = await Promise.all([
      this.prisma.ticket.findFirst({ where: { id, workspaceId, ...ticketScopeWhere(access) }, include: TICKET_DETAIL_INCLUDE }),
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

  async timeline(access: TicketAccess, id: string): Promise<TimelineItemDto[]> {
    await this.visible(access, id);
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

  /**
   * A change of one ticket, behind WorkspaceGuard's `:ticketId` check. The result is returned whatever the caller's departments:
   * a change of department may have just taken the ticket out of them.
   */
  async update(workspaceId: string, id: string, input: UpdateTicketInput, userId: string): Promise<TicketDto> {
    const ticket = await this.get(workspaceId, id);
    const targets = await this.assertTargets(workspaceId, input);
    await this.apply(ticket, input, userId, await this.fields.list(workspaceId, 'ticket'), targets);
    return this.getDetail(systemAccess(workspaceId), id);
  }

  /**
   * One change for many tickets, each through the same path as a single update: events, webhooks and the
   * required fields check. A ticket that refuses the change does not stop the others.
   */
  async bulkUpdate(
    access: TicketAccess,
    target: { ids: string[] } | { filter: TicketListQuery },
    changes: z.infer<typeof BulkTicketChangesSchema>,
    userId: string,
  ): Promise<BulkUpdateTicketsResultDto> {
    const { workspaceId } = access;
    // Ids outside the caller's departments are skipped like missing ones, without a number in `failed`.
    const where =
      'ids' in target
        ? { workspaceId, id: { in: target.ids }, ...ticketScopeWhere(access) }
        : await this.listWhere(access, target.filter, userId);
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
    const targets = await this.assertTargets(workspaceId, input);
    const definitions = await this.fields.list(workspaceId, 'ticket');

    const result: BulkUpdateTicketsResultDto = { updated: [], failed: [] };
    for (const ticket of tickets) {
      const tags =
        addTags || removeTags
          ? [...new Set([...ticket.tags, ...(addTags ?? [])])].filter((tag) => !removeTags?.includes(tag))
          : undefined;
      try {
        await this.apply(ticket, { ...input, ...(tags ? { tags } : {}) }, userId, definitions, targets);
        result.updated.push(ticket.id);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        result.failed.push({ id: ticket.id, number: ticket.number, message: errorText(error) });
      }
    }
    return result;
  }

  /**
   * The department a change sets exists and takes tickets, and the members it assigns can be assigned at all:
   * operators or admins, not disabled. Whether they may take a particular ticket is checked per ticket in `apply`.
   */
  private async assertTargets(workspaceId: string, input: AssigneeChanges & Pick<UpdateTicketInput, 'departmentId'>): Promise<Targets> {
    if (input.departmentId) {
      await this.departments.assertAssignable(workspaceId, input.departmentId);
    }
    const workspace = await this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { settings: true } });
    const ids = [...new Set([...(input.assigneeIds ?? []), ...(input.addAssigneeIds ?? [])])];
    const memberships = await this.prisma.membership.findMany({
      where: { workspaceId, userId: { in: ids } },
      include: { user: true, ...MEMBERSHIP_DEPARTMENTS },
    });
    const members = new Map<string, TargetMember>();
    for (const membership of memberships) {
      const scope = membership.user.isSuperadmin ? ALL_DEPARTMENTS : await membershipScope(this.prisma, workspaceId, membership);
      members.set(membership.userId, { name: membership.user.name, role: membership.role, disabled: membership.user.disabledAt !== null, scope });
    }
    return { members, keepAccess: assignmentSettings(workspace.settings).assigneesKeepAccess };
  }

  /**
   * The assignees after the change, or null when it does not touch them. A member who is added must be assignable and,
   * unless the workspace keeps assignees' access, see the ticket's department after the change.
   */
  private assigneesAfter(
    current: readonly string[],
    input: AssigneeChanges,
    department: string | null,
    targets: Targets,
  ): string[] | null {
    if (input.assigneeIds === undefined && input.addAssigneeIds === undefined && input.removeAssigneeIds === undefined) {
      return null;
    }
    const after =
      input.assigneeIds !== undefined
        ? [...new Set(input.assigneeIds)]
        : [...new Set([...current, ...(input.addAssigneeIds ?? [])])].filter((id) => !input.removeAssigneeIds?.includes(id));
    const path = input.assigneeIds !== undefined ? 'assigneeIds' : input.addAssigneeIds !== undefined ? 'addAssigneeIds' : 'removeAssigneeIds';
    for (const userId of after.filter((id) => !current.includes(id))) {
      const member = targets.members.get(userId);
      if (member === undefined || member.role === 'viewer') {
        throw errors.validation([{ path, message: t('api.assigneeMustBeOperator'), code: 'custom' }]);
      }
      if (member.disabled) {
        throw errors.validation([{ path, message: t('api.assigneeDisabled'), code: 'custom' }]);
      }
    }
    // Everyone the change names, new or kept, must see the department after it, unless assignees keep their access.
    const named = input.assigneeIds ?? input.addAssigneeIds ?? [];
    for (const userId of targets.keepAccess ? [] : named) {
      const member = targets.members.get(userId);
      if (member !== undefined && !canSeeDepartment(member.scope, department)) {
        throw errors.validation([{ path, message: t('api.assigneeNoDepartmentAccess', { name: member.name }), code: 'custom' }]);
      }
    }
    if (!fitsAssigneeLimit(after)) {
      throw errors.validation([{ path, message: t('api.tooManyAssignees', { max: MAX_TICKET_ASSIGNEES }), code: 'custom' }]);
    }
    return after;
  }

  private async apply(
    ticket: Ticket & { channel: Channel | null },
    input: UpdateTicketInput & AssigneeChanges,
    userId: string,
    definitions: FieldDefinitionDto[],
    targets: Targets,
  ): Promise<void> {
    const { workspaceId, id } = ticket;
    const department = input.departmentId !== undefined ? input.departmentId : ticket.departmentId;
    const actor: Actor = { type: 'user', id: userId };
    let fieldResult: ReturnType<typeof applyFieldValues> | null = null;
    const changes: AssigneeChange[] = [];
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
    let moved = null as { from: string | null; to: string | null } | null;
    await this.prisma.$transaction(async (tx) => {
      const data: Prisma.TicketUpdateInput = {};
      let agentInputChanged = false;
      const event = (type: string, eventData: Record<string, unknown>) =>
        recordEvent(tx, { workspaceId, ticketId: id, type, actor, data: eventData });
      // The assignees as they are now, under the ticket's lock: additions and removals apply to them, not to what the page saw.
      await lockTicketForAssignees(tx, id);
      const current = (await tx.ticketAssignee.findMany({ where: { ticketId: id }, select: { userId: true } })).map((a) => a.userId);
      const assignees = this.assigneesAfter(current, input, department, targets);

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
        moved = { from: ticket.departmentId, to: input.departmentId };
        await recordDepartmentChange(tx, ticket, input.departmentId, actor);
      }
      if (assignees !== null) {
        const change: AssigneeChange = { ticketId: id, added: [], removed: [] };
        change.removed = await removeAssignees(tx, ticket, current.filter((a) => !assignees.includes(a)), actor);
        change.added = await addAssignees(tx, ticket, assignees.filter((a) => !current.includes(a)), 'manual', actor);
        // A distributor's pick the operator names is now theirs: a move in the same change must not take it away.
        const named = (input.assigneeIds ?? input.addAssigneeIds ?? []).filter((a) => current.includes(a));
        if (named.length > 0) {
          await tx.ticketAssignee.updateMany({ where: { ticketId: id, userId: { in: named }, source: 'auto' }, data: { source: 'manual' } });
        }
        changes.push(change);
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
      // After the department is written: assignees who lost the ticket go, and the new department may hand it out.
      // A reopened ticket without an assignee of its department is handed out too.
      if (moved !== null) {
        changes.push(await settleAssignees(tx, id, actor, 'department_changed'));
      } else if (reopens(ticket.status, input.status)) {
        changes.push(await settleAssignees(tx, id, actor, 'reopened'));
      }
    });

    await this.outbound.schedule(deliveries);
    if (moved !== null) {
      await this.realtime.publish(workspaceId, { type: 'ticket.moved', ticketId: id, ...moved });
    }
    await publishAssigneeChanges(this.realtime, this.notifications, workspaceId, changes, userId);
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

/** The assignee fields of a change: `assigneeIds` replaces the list, the bulk change also adds and removes. */
type AssigneeChanges = Pick<z.infer<typeof BulkTicketChangesSchema>, 'assigneeIds' | 'addAssigneeIds' | 'removeAssigneeIds'>;

interface TargetMember {
  name: string;
  role: WorkspaceRole;
  disabled: boolean;
  /** The departments they see through their own access. */
  scope: DepartmentScope;
}

/** The members a change may assign, and whether the workspace lets assignees see tickets outside their departments. */
interface Targets {
  members: Map<string, TargetMember>;
  keepAccess: boolean;
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
