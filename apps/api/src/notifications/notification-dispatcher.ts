import { t, tp } from '@kvitok/i18n';
import { Inject, Injectable } from '@nestjs/common';
import { notificationSettings } from '@kvitok/shared';
import { departmentScopeOf, MEMBERSHIP_DEPARTMENTS, triageDepartmentId } from '../departments/department-access';
import type { Department, Ticket } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { wants, type NotificationKind, type Recipient, type TicketFacts } from './notification-rules';
import type { NotifyJobData } from './notifications.constants';
import { NOTIFIER_CHANNELS, type Notification, type NotifierChannel } from './notifier-channel';

const SNIPPET_LENGTH = 200;

type TicketRow = Ticket & { department: Department | null; workspace: { name: string } };

/** What happened, read once per job; each member gets their own kind and text from it. */
interface EventContext {
  facts: TicketFacts;
  /** `incoming`: customer messages since the job was queued and the last one's text. */
  messages: number;
  lastMessage: string | null;
  /** The agent's open question, if it asked one. */
  question: string | null;
}

/** Picks the members who want the event and sends each of them one notification through every channel. */
@Injectable()
export class NotificationDispatcher {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(NOTIFIER_CHANNELS) private readonly channels: NotifierChannel[],
  ) {}

  async dispatch(data: NotifyJobData): Promise<number> {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: data.ticketId },
      include: { department: true, workspace: { select: { name: true } } },
    });
    if (ticket === null || ticket.workspaceId !== data.workspaceId) return 0;
    const context = await this.context(data, ticket);
    if (context === null) return 0;

    const [members, triageId] = await Promise.all([
      this.prisma.membership.findMany({
        where: { workspaceId: data.workspaceId, user: { disabledAt: null }, ...(data.actorId ? { userId: { not: data.actorId } } : {}) },
        select: { userId: true, role: true, allDepartments: true, notificationSettings: true, ...MEMBERSHIP_DEPARTMENTS },
      }),
      triageDepartmentId(this.prisma, data.workspaceId),
    ]);
    const ids = members.map((m) => m.userId);
    const reachable = new Set<string>();
    for (const channel of this.channels) {
      for (const id of await channel.reachable(ids)) reachable.add(id);
    }
    const workspaceCounts = await this.workspaceCounts([...reachable]);

    let sent = 0;
    for (const member of members) {
      if (!reachable.has(member.userId)) continue;
      const recipient: Recipient = {
        userId: member.userId,
        role: member.role,
        settings: notificationSettings(member.notificationSettings),
        departments: departmentScopeOf(member, triageId),
      };
      const kind = pickKind(data, recipient, context.facts);
      if (kind === null) continue;
      const notification = render(kind, ticket, context, {
        needsOperator: data.needsOperator === true,
        workspaceName: (workspaceCounts.get(member.userId) ?? 1) > 1 ? ticket.workspace.name : null,
      });
      for (const channel of this.channels) await channel.deliver(member.userId, notification);
      sent += 1;
    }
    return sent;
  }

  private async context(data: NotifyJobData, ticket: TicketRow): Promise<EventContext | null> {
    const facts: TicketFacts = { departmentId: ticket.departmentId, assigneeId: ticket.assigneeId, priority: ticket.priority };
    const since = data.since ? new Date(data.since) : ticket.createdAt;
    let messages = 0;
    let lastMessage: string | null = null;
    let question: string | null = null;

    if (data.kind === 'incoming') {
      const where = { ticketId: ticket.id, authorType: 'customer' as const, createdAt: { gte: since } };
      const [count, last] = await Promise.all([
        this.prisma.message.count({ where }),
        this.prisma.message.findFirst({ where, orderBy: { createdAt: 'desc' }, select: { bodyClean: true, bodyText: true } }),
      ]);
      if (count === 0 && !data.created) return null;
      messages = count;
      lastMessage = last ? snippet(last.bodyClean || last.bodyText) : null;
    }
    if (data.kind === 'agent_needs_operator' || data.needsOperator) {
      const open = await this.prisma.agentQuestion.findFirst({
        where: { ticketId: ticket.id, status: 'open', createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        select: { text: true },
      });
      question = open ? snippet(open.text) : null;
    }
    if (data.kind === 'delivery_failed' && data.messageId) {
      const message = await this.prisma.message.findUnique({ where: { id: data.messageId }, select: { authorUserId: true } });
      facts.authorId = message?.authorUserId ?? null;
    }
    return { facts, messages, lastMessage, question };
  }

  private async workspaceCounts(userIds: string[]): Promise<Map<string, number>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.prisma.membership.groupBy({ by: ['userId'], where: { userId: { in: userIds } }, _count: { _all: true } });
    return new Map(rows.map((row) => [row.userId, row._count._all]));
  }
}

/** The kind this member gets for the job, or null. An incoming message the member does not follow may still need them as an operator. */
export function pickKind(data: NotifyJobData, recipient: Recipient, facts: TicketFacts): NotificationKind | null {
  if (data.kind !== 'incoming') return wants(recipient, data.kind, facts) ? data.kind : null;
  const kind: NotificationKind = !data.created ? 'customer_message' : facts.assigneeId === recipient.userId ? 'assigned' : 'ticket_created';
  if (wants(recipient, kind, facts)) return kind;
  return data.needsOperator && wants(recipient, 'agent_needs_operator', facts) ? 'agent_needs_operator' : null;
}

function render(
  kind: NotificationKind,
  ticket: TicketRow,
  context: EventContext,
  options: { needsOperator: boolean; workspaceName: string | null },
): Notification {
  const number = ticket.number;
  const subject = ticket.subject.trim() || t('api.noSubject');
  const summary = agentSummary(ticket);
  let title: string;
  let lines: Array<string | null>;

  switch (kind) {
    case 'ticket_created':
      title = ticket.department ? t('notifications.push.ticketCreatedIn', { number, department: ticket.department.title }) : t('notifications.push.ticketCreated', { number });
      lines = [subject, summary ?? context.lastMessage];
      break;
    case 'assigned':
      title = t('notifications.push.assigned', { number });
      lines = [subject, summary];
      break;
    case 'customer_message':
      title = tp('notifications.push.customerMessages', Math.max(context.messages, 1), { number });
      lines = [subject, context.lastMessage];
      break;
    case 'agent_needs_operator':
      title = t('notifications.push.agentNeedsOperator', { number });
      lines = [subject, context.question ?? t('notifications.push.actionProposed')];
      break;
    case 'delivery_failed':
      title = t('notifications.push.deliveryFailed', { number });
      lines = [subject];
      break;
    case 'agent_failed':
      title = t('notifications.push.agentFailed', { number });
      lines = [subject];
      break;
  }
  if (options.needsOperator && kind !== 'agent_needs_operator') {
    lines.push(context.question ? t('notifications.push.agentAsks', { question: context.question }) : t('notifications.push.actionProposed'));
  }

  return {
    title: options.workspaceName ? `${options.workspaceName} · ${title}` : title,
    body: lines.filter((line): line is string => Boolean(line)).join('\n'),
    url: `/w/${ticket.workspaceId}/tickets/${ticket.id}`,
    tag: `ticket:${ticket.id}`,
    urgent: ticket.priority === 'high' || ticket.priority === 'urgent',
  };
}

function agentSummary(ticket: Ticket): string | null {
  const analysis = ticket.analysis as { summary?: unknown } | null;
  return typeof analysis?.summary === 'string' && analysis.summary.trim() ? snippet(analysis.summary) : null;
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_LENGTH ? `${flat.slice(0, SNIPPET_LENGTH - 1)}…` : flat;
}
