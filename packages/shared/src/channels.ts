import { t } from '@kvitok/i18n';
import { z } from 'zod';
import { EmailSchema } from './auth.js';

export const CHANNEL_TYPES = ['api', 'email'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

/** smtp — real sending; sandbox — a test mailbox: emails are kept in the system and never leave it. */
export const MAIL_TRANSPORTS = ['smtp', 'sandbox'] as const;
export type MailTransport = (typeof MAIL_TRANSPORTS)[number];

const HostSchema = z.string().trim().min(1).max(255);
const PortSchema = z.number().int().min(1).max(65_535);

export const SmtpConfigSchema = z.object({
  host: HostSchema,
  port: PortSchema,
  secure: z.boolean().default(true),
  user: z.string().trim().min(1).max(320),
  /** May be omitted on update — the current one stays. */
  password: z.string().min(1).max(500).optional(),
});

export const ImapConfigSchema = z.object({
  host: HostSchema,
  port: PortSchema,
  secure: z.boolean().default(true),
  user: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(500).optional(),
  folder: z.string().trim().min(1).max(200).default('INBOX'),
  /** Whether to import the emails that were in the mailbox before it was connected. */
  importExisting: z.boolean().default(false),
});

/** metadata.<path> from ingest → ticket field key. */
export const MetadataMappingSchema = z.record(z.string().trim().min(1).max(200), z.string().trim().min(1).max(48));

export const CreateApiChannelSchema = z.object({
  type: z.literal('api'),
  name: z.string().trim().min(1).max(120),
  metadataMapping: MetadataMappingSchema.default({}),
  webhookUrl: z.url().nullable().default(null),
});

export const CreateEmailChannelSchema = z
  .object({
    type: z.literal('email'),
    transport: z.enum(MAIL_TRANSPORTS).default('smtp'),
    name: z.string().trim().min(1).max(120),
    address: EmailSchema,
    displayName: z.string().trim().max(200).default(''),
    signatureHtml: z.string().max(20_000).default(''),
    smtp: SmtpConfigSchema.nullable().default(null),
    imap: ImapConfigSchema.nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (value.transport === 'smtp' && value.smtp === null) {
      ctx.addIssue({ code: 'custom', path: ['smtp'], message: t('validation.smtpRequired') });
    }
    if (value.transport === 'sandbox' && (value.smtp !== null || value.imap !== null)) {
      ctx.addIssue({ code: 'custom', path: ['transport'], message: t('validation.sandboxHasNoServers') });
    }
  });

export const CreateChannelSchema = z.discriminatedUnion('type', [CreateApiChannelSchema, CreateEmailChannelSchema]);
export type CreateChannelInput = z.input<typeof CreateChannelSchema>;

export const UpdateChannelSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  metadataMapping: MetadataMappingSchema.optional(),
  webhookUrl: z.url().nullable().optional(),
  displayName: z.string().trim().max(200).optional(),
  signatureHtml: z.string().max(20_000).optional(),
  smtp: SmtpConfigSchema.optional(),
  imap: ImapConfigSchema.nullable().optional(),
});
export type UpdateChannelInput = z.input<typeof UpdateChannelSchema>;

export interface ChannelDto {
  id: string;
  type: ChannelType;
  name: string;
  enabled: boolean;
  createdAt: string;
  /** api */
  apiKeyPrefix?: string | null;
  metadataMapping?: Record<string, string>;
  webhookUrl?: string | null;
  hasWebhookSecret?: boolean;
  /** email; passwords are never returned */
  transport?: MailTransport;
  address?: string;
  displayName?: string;
  signatureHtml?: string;
  /** null for a test mailbox */
  smtp?: (Omit<z.infer<typeof SmtpConfigSchema>, 'password'> & { hasPassword: boolean }) | null;
  imap?: (Omit<z.infer<typeof ImapConfigSchema>, 'password'> & { hasPassword: boolean }) | null;
  lastSyncAt?: string | null;
  lastSyncError?: string | null;
  isDefaultMailbox?: boolean;
}

/** Response to creating an API channel and rotating the key: the key and the webhook secret are shown once. */
export interface ChannelSecretsDto {
  channel: ChannelDto;
  apiKey?: string;
  webhookSecret?: string;
}

export const SandboxEmailListQuerySchema = z.object({
  /** Substring of a recipient address (to or cc). */
  address: z.string().trim().max(320).optional(),
  ticketId: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type SandboxEmailListQuery = z.infer<typeof SandboxEmailListQuerySchema>;

/** An email "sent" by a test mailbox: parsed from the MIME that would have gone over SMTP. */
export interface SandboxEmailListItemDto {
  id: string;
  channelId: string;
  ticket: { id: string; number: number } | null;
  deliveryId: string | null;
  from: { address: string; name: string | null };
  to: string[];
  cc: string[];
  subject: string;
  size: number;
  attachmentCount: number;
  createdAt: string;
}

export interface SandboxEmailDto extends SandboxEmailListItemDto {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  html: string | null;
  text: string;
  attachments: Array<{ filename: string; contentType: string; size: number }>;
  headers: Array<{ key: string; value: string }>;
}

export interface SandboxEmailListDto {
  items: SandboxEmailListItemDto[];
  total: number;
  page: number;
  pageSize: number;
}
