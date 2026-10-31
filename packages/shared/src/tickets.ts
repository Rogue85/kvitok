import { z } from 'zod';
import type { FieldMeta, FieldValues } from './fields.js';

export const TICKET_STATUSES = ['new', 'open', 'pending', 'resolved', 'closed'] as const;
export const TicketStatusSchema = z.enum(TICKET_STATUSES);
export type TicketStatus = z.infer<typeof TicketStatusSchema>;

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const TicketPrioritySchema = z.enum(TICKET_PRIORITIES);
export type TicketPriority = z.infer<typeof TicketPrioritySchema>;

export const TagSchema = z.string().trim().toLowerCase().min(1).max(64);

export const TicketListQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',') : undefined))
    .pipe(z.array(TicketStatusSchema).optional()),
  departmentId: z.string().optional(),
  /** user id, `me` or `none` */
  assignee: z.string().optional(),
  q: z.string().trim().max(200).optional(),
  /** Field filter: the controller collects field.<key>=<value> into this object. */
  fields: z.record(z.string(), z.string()).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type TicketListQuery = z.infer<typeof TicketListQuerySchema>;

export const UpdateTicketSchema = z
  .object({
    subject: z.string().trim().min(1).max(500),
    status: TicketStatusSchema,
    priority: TicketPrioritySchema,
    departmentId: z.string().nullable(),
    assigneeId: z.string().nullable(),
    tags: z.array(TagSchema).max(50),
    /** null clears the value. */
    fields: z.record(z.string(), z.unknown()),
  })
  .partial();
export type UpdateTicketInput = z.infer<typeof UpdateTicketSchema>;

/** An operator's message to the agent (visible to the team only). Always wakes the agent. */
export const CreateAgentMessageSchema = z.object({
  body: z.string().trim().min(1).max(50_000),
});
export type CreateAgentMessageInput = z.input<typeof CreateAgentMessageSchema>;

export const REPLY_VIA = ['email', 'source'] as const;

export const CreateReplySchema = z.object({
  bodyHtml: z.string().trim().min(1).max(500_000),
  bodyText: z.string().max(500_000).optional(),
  via: z.array(z.enum(REPLY_VIA)).min(1),
  to: z.array(z.string().trim().toLowerCase().pipe(z.email())).max(20).optional(),
  cc: z.array(z.string().trim().toLowerCase().pipe(z.email())).max(20).default([]),
  statusAfter: z.enum(['pending', 'resolved']).nullable().default('pending'),
  /** The last message the operator saw. If the customer wrote after it — 409 unless force is passed. */
  lastSeenMessageId: z.string().optional(),
  force: z.boolean().default(false),
});
export type CreateReplyInput = z.input<typeof CreateReplySchema>;

export interface UserRefDto {
  id: string;
  name: string;
  email: string;
}

export interface CustomerIdentityDto {
  type: string;
  value: string;
}

export interface CustomerDto {
  id: string;
  name: string | null;
  identities: CustomerIdentityDto[];
  fields: FieldValues;
  fieldMeta: FieldMeta;
}

export interface TicketListItemDto {
  id: string;
  number: number;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  departmentId: string | null;
  assignee: UserRefDto | null;
  customer: { id: string; name: string | null; primaryIdentity: CustomerIdentityDto | null } | null;
  channel: { id: string; type: 'api' | 'email'; name: string } | null;
  tags: string[];
  fields: FieldValues;
  lastMessageAt: string;
  createdAt: string;
}

export interface TicketListDto {
  items: TicketListItemDto[];
  total: number;
  page: number;
  pageSize: number;
}

export interface TicketDto extends Omit<TicketListItemDto, 'customer'> {
  departmentLocked: boolean;
  fieldMeta: FieldMeta;
  revision: number;
  customer: CustomerDto | null;
  participants: Array<{ email: string; name: string | null; role: 'customer' | 'cc' }>;
  /** Channels the reply can go through. */
  replyOptions: { email: { mailboxId: string; address: string } | null; source: boolean };
}

export type DeliveryStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled';

export interface DeliveryDto {
  id: string;
  kind: 'email' | 'webhook';
  status: DeliveryStatus;
  scheduledAt: string;
  sentAt: string | null;
  lastError: string | null;
  attempts: number;
  /** The email landed in a test mailbox — a link to it. */
  sandboxEmail: { id: string; channelId: string } | null;
}

export interface AttachmentDto {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface MessageDto {
  id: string;
  authorType: 'customer' | 'operator' | 'agent' | 'system';
  author: UserRefDto | null;
  visibility: 'public' | 'internal';
  source: 'email' | 'api' | 'ui';
  subject: string | null;
  bodyText: string;
  bodyHtml: string | null;
  bodyClean: string | null;
  fromEmail: string | null;
  fromName: string | null;
  to: string[];
  cc: string[];
  isAutomated: boolean;
  /** A message to the agent answering its question. */
  answersQuestionId: string | null;
  createdAt: string;
  attachments: AttachmentDto[];
  deliveries: DeliveryDto[];
}

export interface TicketEventDto {
  id: string;
  type: string;
  actorType: string;
  actor: UserRefDto | null;
  data: Record<string, unknown>;
  createdAt: string;
}

export type TimelineItemDto =
  | { kind: 'message'; at: string; message: MessageDto }
  | { kind: 'event'; at: string; event: TicketEventDto };
