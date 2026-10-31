import { z } from 'zod';
import { IdentitiesSchema } from './identities.js';

/** Body of `POST /api/v1/ingest/:channelId`. The external API uses snake_case. */
export const IngestMessageSchema = z.object({
  external_id: z.string().trim().min(1).max(200),
  conversation_external_id: z.string().trim().min(1).max(200).optional(),
  customer: z.object({
    name: z.string().trim().max(200).optional(),
    identities: IdentitiesSchema.default({}),
    fields: z.record(z.string(), z.unknown()).optional(),
  }),
  subject: z.string().trim().max(500).optional(),
  body: z.string().trim().min(1).max(100_000),
  body_html: z.string().max(500_000).optional(),
  /** When the customer sent the message (history import, delayed delivery). A time in the future is replaced with now. */
  sent_at: z.iso.datetime({ offset: true }).optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type IngestMessageInput = z.input<typeof IngestMessageSchema>;

export interface IngestResponseDto {
  ticket_id: string;
  ticket_number: number;
  message_id: string;
  /** true — a message with this external_id was already accepted, nothing was created. */
  duplicate: boolean;
  /** Fields dropped by validation. */
  rejected_fields: Array<{ key: string; reason: string }>;
}
