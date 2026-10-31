import { Body, Controller, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import { IngestMessageSchema, type IngestMessageInput, type IngestResponseDto } from '@kvitok/shared';
import type { FastifyReply } from 'fastify';
import { Public } from '../auth/decorators';
import { apiConfig } from '../channels/channel-config';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { IngestAuthGuard, type IngestRequest } from './ingest-auth.guard';
import { InboundService } from './inbound.service';

@Controller('v1/ingest')
export class IngestController {
  constructor(private readonly inbound: InboundService) {}

  @Public()
  @UseGuards(IngestAuthGuard)
  @Post(':channelId')
  async ingest(
    @Body(new ZodValidationPipe(IngestMessageSchema)) body: Required<Pick<IngestMessageInput, 'customer'>> & IngestMessageInput,
    @Req() request: IngestRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<IngestResponseDto> {
    const channel = request.channel!;
    const mapped = mapMetadata(body.metadata ?? {}, apiConfig(channel).metadataMapping);
    const email = body.customer.identities?.email;

    const result = await this.inbound.receive({
      channel,
      source: 'api',
      conversationExternalId: body.conversation_external_id,
      customer: { name: body.customer.name, identities: body.customer.identities ?? {}, fields: body.customer.fields },
      subject: body.subject ?? '',
      bodyText: body.body,
      bodyHtml: body.body_html ?? null,
      bodyClean: body.body,
      externalId: body.external_id,
      sentAt: body.sent_at ? new Date(body.sent_at) : undefined,
      fromName: body.customer.name ?? null,
      fromEmail: email ? email.trim().toLowerCase() : null,
      ticketFields: { ...mapped, ...(body.fields ?? {}) },
      headers: body.metadata ? { metadata: body.metadata } : null,
      participants: email ? [{ email: email.trim().toLowerCase(), name: body.customer.name ?? null, role: 'customer' }] : [],
    });

    reply.status(result.duplicate ? HttpStatus.OK : HttpStatus.CREATED);
    return {
      ticket_id: result.ticketId,
      ticket_number: result.ticketNumber,
      message_id: result.messageId,
      duplicate: result.duplicate,
      rejected_fields: result.rejectedFields,
    };
  }
}

/** `{ "form.category": "category" }` + metadata `{ form: { category: "bonus" } }` → `{ category: "bonus" }`. */
export function mapMetadata(metadata: Record<string, unknown>, mapping: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [path, fieldKey] of Object.entries(mapping)) {
    const value = path.split('.').reduce<unknown>(
      (node, part) => (node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
      metadata,
    );
    if (value !== undefined) {
      result[fieldKey] = value;
    }
  }
  return result;
}
