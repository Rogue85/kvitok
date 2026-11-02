import type {
  DeliveryDto,
  FieldMeta,
  FieldValues,
  MessageDto,
  TicketEventDto,
  TicketListItemDto,
  UserRefDto,
} from '@kvitok/shared';
import type {
  Attachment,
  Channel,
  Customer,
  CustomerIdentity,
  Delivery,
  Message,
  Prisma,
  Ticket,
  TicketAssignee,
  TicketEvent,
  User,
} from '../generated/prisma/client';
import { primaryIdentity } from '../customers/customers.service';

export const TICKET_LIST_INCLUDE = {
  assignees: { include: { user: true }, orderBy: [{ addedAt: 'asc' }, { userId: 'asc' }] },
  channel: true,
  customer: { include: { identities: true } },
} satisfies Prisma.TicketInclude;

export const TICKET_DETAIL_INCLUDE = {
  ...TICKET_LIST_INCLUDE,
  participants: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.TicketInclude;

export const MESSAGE_INCLUDE = {
  authorUser: true,
  attachments: { orderBy: { createdAt: 'asc' } },
  deliveries: { orderBy: { createdAt: 'asc' }, include: { sandboxEmail: { select: { id: true, channelId: true } } } },
} satisfies Prisma.MessageInclude;

type ListTicket = Ticket & {
  assignees: Array<TicketAssignee & { user: User }>;
  channel: Channel | null;
  customer: (Customer & { identities: CustomerIdentity[] }) | null;
};

export function toUserRef(user: Pick<User, 'id' | 'name' | 'email'> | null | undefined): UserRefDto | null {
  return user ? { id: user.id, name: user.name, email: user.email } : null;
}

export function toTicketListItem(ticket: ListTicket): TicketListItemDto {
  return {
    id: ticket.id,
    number: ticket.number,
    subject: ticket.subject,
    status: ticket.status,
    priority: ticket.priority,
    departmentId: ticket.departmentId,
    assignees: ticket.assignees.map((a) => ({
      id: a.user.id,
      name: a.user.name,
      email: a.user.email,
      source: a.source,
      addedAt: a.addedAt.toISOString(),
      actedAt: a.actedAt?.toISOString() ?? null,
    })),
    customer: ticket.customer
      ? { id: ticket.customer.id, name: ticket.customer.name, primaryIdentity: primaryIdentity(ticket.customer.identities) }
      : null,
    channel: ticket.channel ? { id: ticket.channel.id, type: ticket.channel.type, name: ticket.channel.name } : null,
    tags: ticket.tags,
    fields: ticket.fields as FieldValues,
    agentState: ticket.agentState,
    lastMessageAt: ticket.lastMessageAt.toISOString(),
    createdAt: ticket.createdAt.toISOString(),
  };
}

type DeliveryRow = Delivery & { sandboxEmail?: { id: string; channelId: string } | null };

export function toDeliveryDto(delivery: DeliveryRow): DeliveryDto {
  return {
    id: delivery.id,
    kind: delivery.kind,
    status: delivery.status,
    scheduledAt: delivery.scheduledAt.toISOString(),
    sentAt: delivery.sentAt?.toISOString() ?? null,
    lastError: delivery.lastError,
    attempts: delivery.attempts,
    sandboxEmail: delivery.sandboxEmail ?? null,
  };
}

export function toMessageDto(
  message: Message & { authorUser: User | null; attachments: Attachment[]; deliveries: DeliveryRow[] },
): MessageDto {
  return {
    id: message.id,
    authorType: message.authorType,
    author: toUserRef(message.authorUser),
    visibility: message.visibility,
    source: message.source,
    subject: message.subject,
    bodyText: message.bodyText,
    bodyHtml: message.bodyHtml,
    bodyClean: message.bodyClean,
    fromEmail: message.fromEmail,
    fromName: message.fromName,
    to: message.to,
    cc: message.cc,
    isAutomated: message.isAutomated,
    answersQuestionId: message.answersQuestionId,
    createdAt: message.createdAt.toISOString(),
    attachments: message.attachments.map((a) => ({ id: a.id, filename: a.filename, contentType: a.contentType, size: a.size })),
    deliveries: message.deliveries.map(toDeliveryDto),
  };
}

export function toEventDto(event: TicketEvent, users: Map<string, User>): TicketEventDto {
  return {
    id: event.id,
    type: event.type,
    actorType: event.actorType,
    actor: event.actorType === 'user' && event.actorId ? toUserRef(users.get(event.actorId)) : null,
    data: event.data as Record<string, unknown>,
    createdAt: event.createdAt.toISOString(),
  };
}

export function fieldState(ticket: Pick<Ticket, 'fields' | 'fieldMeta'>): { values: FieldValues; meta: FieldMeta } {
  return { values: ticket.fields as FieldValues, meta: ticket.fieldMeta as unknown as FieldMeta };
}
