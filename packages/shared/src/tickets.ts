import { t } from '@kvitok/i18n';
import { z } from 'zod';
import type { FieldMeta, FieldValues } from './fields.js';

export const TICKET_STATUSES = ['new', 'open', 'pending', 'resolved', 'closed'] as const;
export const TicketStatusSchema = z.enum(TICKET_STATUSES);
export type TicketStatus = z.infer<typeof TicketStatusSchema>;

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const TicketPrioritySchema = z.enum(TICKET_PRIORITIES);
export type TicketPriority = z.infer<typeof TicketPrioritySchema>;

export const TagSchema = z.string().trim().toLowerCase().min(1).max(64);

export const TICKET_AGENT_STATES = ['idle', 'queued', 'running', 'failed'] as const;

/** Queue order: `updated` — the latest message first, `oldest` — the longest without a new message first. */
export const TICKET_SORTS = ['updated', 'oldest', 'created', 'priority'] as const;
export type TicketSort = (typeof TICKET_SORTS)[number];

/** A comma-separated query parameter as a list; an empty one is no filter. */
function csv<T extends z.ZodType<string>>(item: T) {
  return z.preprocess((s) => (typeof s === 'string' ? s.split(',').filter((v) => v !== '') : s), z.array(item).optional());
}

const queryFlag = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const queryDate = z.iso
  .datetime({ offset: true })
  .optional()
  .transform((v) => (v ? new Date(v) : undefined));

export const TicketListQuerySchema = z.object({
  status: csv(TicketStatusSchema),
  priority: csv(TicketPrioritySchema),
  /** Department ids, `none` — without a department. */
  departmentId: csv(z.string()),
  /** User ids, `me` or `none`. */
  assignee: csv(z.string()),
  channelId: csv(z.string()),
  /** Any of the tags. */
  tags: csv(TagSchema),
  agentState: csv(z.enum(TICKET_AGENT_STATES)),
  /** Waits for the operator: an open question of the agent, a proposed action, a customer to confirm. */
  attention: queryFlag,
  createdFrom: queryDate,
  createdTo: queryDate,
  /** By the last message. */
  updatedFrom: queryDate,
  updatedTo: queryDate,
  q: z.string().trim().max(200).optional(),
  /** Field filter: the controller collects field.<key>=<value> into this object. */
  fields: z.record(z.string(), z.string()).optional(),
  sort: z.enum(TICKET_SORTS).default('updated'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type TicketListQuery = z.infer<typeof TicketListQuerySchema>;

/** The most tickets one bulk update changes. */
export const BULK_TICKETS_LIMIT = 500;

export const BulkTicketChangesSchema = z
  .object({
    status: TicketStatusSchema,
    priority: TicketPrioritySchema,
    departmentId: z.string().nullable(),
    assigneeId: z.string().nullable(),
    addTags: z.array(TagSchema).min(1).max(50),
    removeTags: z.array(TagSchema).min(1).max(50),
  })
  .partial()
  .refine((c) => Object.keys(c).length > 0, { error: () => t('validation.nothingToChange') });

export const BulkUpdateTicketsSchema = z
  .object({
    /** Tickets by id… */
    ids: z.array(z.string()).min(1).max(BULK_TICKETS_LIMIT).optional(),
    /** …or every ticket of a list filter: the list's query parameters, `page` and `pageSize` are ignored. */
    filter: z.record(z.string(), z.string()).optional(),
    changes: BulkTicketChangesSchema,
  })
  .refine((b) => (b.ids === undefined) !== (b.filter === undefined), { error: () => t('validation.idsOrFilter'), path: ['ids'] });
export type BulkUpdateTicketsInput = z.infer<typeof BulkUpdateTicketsSchema>;

export interface BulkUpdateTicketsResultDto {
  /** Tickets the update was applied to, changed or already as requested. */
  updated: string[];
  /** Tickets that refused the change, with the reason. */
  failed: Array<{ id: string; number: number; message: string }>;
}

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
  agentState: (typeof TICKET_AGENT_STATES)[number];
  lastMessageAt: string;
  createdAt: string;
}

export interface TicketListRowDto extends TicketListItemDto {
  /** Waits for the operator: an open question of the agent, a proposed action, a customer to confirm. */
  attention: boolean;
}

/** Tickets of a list filter by status, whatever status the filter has. */
export type TicketCountsDto = Record<TicketStatus, number>;

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

/** A saved queue: the page's URL query by its keys (tab, sort, search, filters), without the page. */
export const TicketViewQuerySchema = z
  .record(z.string().min(1).max(100), z.string().max(2000))
  .refine((q) => Object.keys(q).length <= 50, { error: () => t('validation.tooManyKeys', { max: 50 }) });

export const CreateTicketViewSchema = z.object({
  name: z.string().trim().min(1).max(100),
  /** Visible to every member of the workspace; only admins share and change shared views. */
  shared: z.boolean().default(false),
  query: TicketViewQuerySchema,
});
export type CreateTicketViewInput = z.input<typeof CreateTicketViewSchema>;

export const UpdateTicketViewSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    shared: z.boolean(),
    query: TicketViewQuerySchema,
  })
  .partial();
export type UpdateTicketViewInput = z.infer<typeof UpdateTicketViewSchema>;

export interface TicketViewDto {
  id: string;
  name: string;
  shared: boolean;
  query: Record<string, string>;
  author: UserRefDto | null;
  /** The caller may change and delete it: their personal view, or a shared one for an admin. */
  editable: boolean;
  createdAt: string;
  updatedAt: string;
}
