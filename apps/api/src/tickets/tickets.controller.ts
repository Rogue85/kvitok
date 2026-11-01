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
import type { AuthContext, WorkspaceContext } from '../common/request';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentWorkspace, RequireRole, WorkspaceGuard } from '../workspaces/workspace.guard';
import { TicketsService } from './tickets.service';

const FIELD_FILTER_PREFIX = 'field.';

@Controller('workspaces/:workspaceId/tickets')
@UseGuards(WorkspaceGuard)
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get()
  list(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Query() rawQuery: Record<string, string>,
    @CurrentAuth() auth: AuthContext,
  ): Promise<TicketListDto> {
    return this.tickets.list(workspace, parseListQuery(rawQuery), auth.user.id);
  }

  @Get('counts')
  counts(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Query() rawQuery: Record<string, string>,
    @CurrentAuth() auth: AuthContext,
  ): Promise<TicketCountsDto> {
    return this.tickets.counts(workspace, parseListQuery(rawQuery), auth.user.id);
  }

  @Get('tags')
  tags(@CurrentWorkspace() workspace: WorkspaceContext): Promise<string[]> {
    return this.tickets.tags(workspace);
  }

  @Post('bulk')
  @HttpCode(200)
  @RequireRole('operator')
  bulkUpdate(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Body(new ZodValidationPipe(BulkUpdateTicketsSchema)) body: BulkUpdateTicketsInput,
    @CurrentAuth() auth: AuthContext,
  ): Promise<BulkUpdateTicketsResultDto> {
    const target = body.ids ? { ids: body.ids } : { filter: parseListQuery(body.filter ?? {}) };
    return this.tickets.bulkUpdate(workspace, target, body.changes, auth.user.id);
  }

  @Get(':ticketId')
  get(@CurrentWorkspace() workspace: WorkspaceContext, @Param('ticketId') ticketId: string): Promise<TicketDto> {
    return this.tickets.getDetail(workspace, ticketId);
  }

  @Get(':ticketId/timeline')
  timeline(@CurrentWorkspace() workspace: WorkspaceContext, @Param('ticketId') ticketId: string): Promise<TimelineItemDto[]> {
    return this.tickets.timeline(workspace, ticketId);
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
