import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import {
  TicketListQuerySchema,
  UpdateTicketSchema,
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
    const fields = Object.fromEntries(
      Object.entries(rawQuery)
        .filter(([key]) => key.startsWith(FIELD_FILTER_PREFIX))
        .map(([key, value]) => [key.slice(FIELD_FILTER_PREFIX.length), value]),
    );
    const query = new ZodValidationPipe(TicketListQuerySchema).transform({ ...rawQuery, fields });
    return this.tickets.list(workspaceId, query, auth.user.id);
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
