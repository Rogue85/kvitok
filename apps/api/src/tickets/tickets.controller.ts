import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  BulkUpdateTicketsSchema,
  TicketListQuerySchema,
  type BulkUpdateTicketsInput,
  type BulkUpdateTicketsResultDto,
  type TicketListQuery,
  UpdateTicketSchema,
  type TicketCountsDto,
  type TicketDto,
  type TicketListDto,
  type TimelineItemDto,
  type UpdateTicketInput,
} from '@kvitok/shared';
import { CurrentAuth } from '../auth/decorators';
import type { AuthContext } from '../common/request';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireRole, WorkspaceGuard } from '../workspaces/workspace.guard';
import { TicketsService } from './tickets.service';

const FIELD_FILTER_PREFIX = 'field.';

@Controller('workspaces/:workspaceId/tickets')
@UseGuards(WorkspaceGuard)
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get()
  list(
    @Param('workspaceId') workspaceId: string,
    @Query() rawQuery: Record<string, string>,
    @CurrentAuth() auth: AuthContext,
  ): Promise<TicketListDto> {
    return this.tickets.list(workspaceId, parseListQuery(rawQuery), auth.user.id);
  }

  @Get('counts')
  counts(
    @Param('workspaceId') workspaceId: string,
    @Query() rawQuery: Record<string, string>,
    @CurrentAuth() auth: AuthContext,
  ): Promise<TicketCountsDto> {
    return this.tickets.counts(workspaceId, parseListQuery(rawQuery), auth.user.id);
  }

  @Get('tags')
  tags(@Param('workspaceId') workspaceId: string): Promise<string[]> {
    return this.tickets.tags(workspaceId);
  }

  @Post('bulk')
  @HttpCode(200)
  @RequireRole('operator')
  bulkUpdate(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(BulkUpdateTicketsSchema)) body: BulkUpdateTicketsInput,
    @CurrentAuth() auth: AuthContext,
  ): Promise<BulkUpdateTicketsResultDto> {
    const target = body.ids ? { ids: body.ids } : { filter: parseListQuery(body.filter ?? {}) };
    return this.tickets.bulkUpdate(workspaceId, target, body.changes, auth.user.id);
  }

  @Get(':ticketId')
  get(@Param('workspaceId') workspaceId: string, @Param('ticketId') ticketId: string): Promise<TicketDto> {
    return this.tickets.getDetail(workspaceId, ticketId);
  }

  @Get(':ticketId/timeline')
  timeline(@Param('workspaceId') workspaceId: string, @Param('ticketId') ticketId: string): Promise<TimelineItemDto[]> {
    return this.tickets.timeline(workspaceId, ticketId);
  }

  @Patch(':ticketId')
  @RequireRole('operator')
  update(
    @Param('workspaceId') workspaceId: string,
    @Param('ticketId') ticketId: string,
    @Body(new ZodValidationPipe(UpdateTicketSchema)) body: UpdateTicketInput,
    @CurrentAuth() auth: AuthContext,
  ): Promise<TicketDto> {
    return this.tickets.update(workspaceId, ticketId, body, auth.user.id);
  }
}

/** The list's query parameters: field.<key>=<value> go into `fields`. */
function parseListQuery(raw: Record<string, string>): TicketListQuery {
  const fields = Object.fromEntries(
    Object.entries(raw)
      .filter(([key]) => key.startsWith(FIELD_FILTER_PREFIX))
      .map(([key, value]) => [key.slice(FIELD_FILTER_PREFIX.length), value]),
  );
  return new ZodValidationPipe(TicketListQuerySchema).transform({ ...raw, fields });
}
