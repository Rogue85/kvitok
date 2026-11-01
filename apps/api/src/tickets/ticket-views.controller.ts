import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import {
  CreateTicketViewSchema,
  UpdateTicketViewSchema,
  type TicketViewDto,
  type UpdateTicketViewInput,
} from '@kvitok/shared';
import type { z } from 'zod';
import { CurrentAuth } from '../auth/decorators';
import type { AuthContext, WorkspaceContext } from '../common/request';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentWorkspace, WorkspaceGuard } from '../workspaces/workspace.guard';
import { TicketViewsService } from './ticket-views.service';

/** Saved queue views of the interface; closed to access tokens (no scope on the changing routes). */
@Controller('workspaces/:workspaceId/ticket-views')
@UseGuards(WorkspaceGuard)
export class TicketViewsController {
  constructor(private readonly views: TicketViewsService) {}

  @Get()
  list(@CurrentWorkspace() workspace: WorkspaceContext, @CurrentAuth() auth: AuthContext): Promise<TicketViewDto[]> {
    return this.views.list({ ...workspace, userId: auth.user.id });
  }

  @Post()
  create(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(CreateTicketViewSchema)) body: z.output<typeof CreateTicketViewSchema>,
  ): Promise<TicketViewDto> {
    return this.views.create({ ...workspace, userId: auth.user.id }, body);
  }

  @Patch(':viewId')
  update(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentAuth() auth: AuthContext,
    @Param('viewId') viewId: string,
    @Body(new ZodValidationPipe(UpdateTicketViewSchema)) body: UpdateTicketViewInput,
  ): Promise<TicketViewDto> {
    return this.views.update({ ...workspace, userId: auth.user.id }, viewId, body);
  }

  @Delete(':viewId')
  @HttpCode(204)
  async delete(@CurrentWorkspace() workspace: WorkspaceContext, @CurrentAuth() auth: AuthContext, @Param('viewId') viewId: string): Promise<void> {
    await this.views.delete({ ...workspace, userId: auth.user.id }, viewId);
  }
}
