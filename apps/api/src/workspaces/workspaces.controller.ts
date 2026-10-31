import { t } from '@kvitok/i18n';
import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import {
  CreateWorkspaceSchema,
  UpdateWorkspaceSchema,
  type CreateWorkspaceInput,
  type UpdateWorkspaceInput,
  type WorkspaceDto,
} from '@kvitok/shared';
import { CurrentAuth, RequireScope } from '../auth/decorators';
import { errors } from '../common/errors';
import type { AuthContext } from '../common/request';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireRole, WorkspaceGuard } from './workspace.guard';
import { WorkspacesService } from './workspaces.service';

@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get()
  async list(@CurrentAuth() auth: AuthContext): Promise<WorkspaceDto[]> {
    const workspaces = await this.workspaces.listFor(auth.user);
    const tokenWorkspaceId = auth.token?.workspaceId ?? null;
    return tokenWorkspaceId === null ? workspaces : workspaces.filter((w) => w.id === tokenWorkspaceId);
  }

  @Post()
  @RequireScope('workspaces:create')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(CreateWorkspaceSchema)) body: CreateWorkspaceInput,
  ): Promise<WorkspaceDto> {
    if (!auth.user.isSuperadmin) {
      throw errors.forbidden(t('api.onlySuperadminCreatesWorkspaces'));
    }
    return this.workspaces.create(body, auth.user);
  }

  @Get(':workspaceId')
  @UseGuards(WorkspaceGuard)
  get(@Param('workspaceId') workspaceId: string): Promise<WorkspaceDto> {
    return this.workspaces.get(workspaceId);
  }

  @Patch(':workspaceId')
  @UseGuards(WorkspaceGuard)
  @RequireRole('admin')
  @RequireScope('config:write')
  update(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(UpdateWorkspaceSchema)) body: UpdateWorkspaceInput,
  ): Promise<WorkspaceDto> {
    return this.workspaces.update(workspaceId, body);
  }
}
