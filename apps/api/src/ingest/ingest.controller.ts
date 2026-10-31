import { Body, Controller, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import { IngestMessageSchema, type IngestResponseDto } from '@kvitok/shared';
import type { FastifyReply } from 'fastify';
import { Public } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { IngestAuthGuard, type IngestRequest } from './ingest-auth.guard';
import { InboundService, type ApiIngestMessage } from './inbound.service';

@Controller('v1/ingest')
export class IngestController {
  constructor(private readonly inbound: InboundService) {}

  @Public()
  @UseGuards(IngestAuthGuard)
  @Post(':channelId')
  async ingest(
    @Body(new ZodValidationPipe(IngestMessageSchema)) body: ApiIngestMessage,
    @Req() request: IngestRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<IngestResponseDto> {
    const result = await this.inbound.receiveApi(request.channel!, body);

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
