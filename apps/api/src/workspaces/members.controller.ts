import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import {
  AddMemberSchema,
  SetAcceptingTicketsSchema,
  UpdateMemberSchema,
  type AddMemberInput,
  type AddMemberResult,
  type MemberCandidateDto,
  type MemberDto,
  type PasswordLinkDto,
  type SetAcceptingTicketsInput,
  type UpdateMemberInput,
} from '@kvitok/shared';
import { CurrentAuth } from '../auth/decorators';
import { errors } from '../common/errors';
import type { AuthContext, WorkspaceContext } from '../common/request';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { MembersService } from './members.service';
import { CurrentWorkspace, RequireRole, WorkspaceGuard } from './workspace.guard';

@Controller('workspaces/:workspaceId/members')
@UseGuards(WorkspaceGuard)
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  list(@Param('workspaceId') workspaceId: string): Promise<MemberDto[]> {
    return this.members.list(workspaceId);
  }

  /** Users of the installation who can be given access. */
  @Get('candidates')
  @RequireRole('admin')
  candidates(@Param('workspaceId') workspaceId: string): Promise<MemberCandidateDto[]> {
    return this.members.candidates(workspaceId);
  }

  @Post()
  @RequireRole('admin')
  add(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(AddMemberSchema)) body: AddMemberInput,
  ): Promise<AddMemberResult> {
    return this.members.add(workspaceId, body);
  }

  /** A new invitation link for a member who has not accepted the previous one. */
  @Post(':userId/invite-link')
  @RequireRole('admin')
  inviteLink(
    @CurrentAuth() auth: AuthContext,
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
  ): Promise<PasswordLinkDto> {
    return this.members.inviteLink(auth, workspaceId, userId);
  }

  @Patch(':userId')
  @RequireRole('admin')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(UpdateMemberSchema)) body: UpdateMemberInput,
  ): Promise<MemberDto> {
    return this.members.update(workspaceId, userId, body, auth.user.id);
  }

  /** Members switch their own; admins switch anyone's (someone left without pausing). */
  @Put(':userId/accepting-tickets')
  @RequireRole('operator')
  async setAccepting(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @CurrentAuth() auth: AuthContext,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(SetAcceptingTicketsSchema)) body: SetAcceptingTicketsInput,
  ): Promise<MemberDto> {
    if (workspace.role !== 'admin' && userId !== auth.user.id) {
      throw errors.forbidden();
    }
    return this.members.setAccepting(workspace.workspaceId, userId, body.accepting);
  }

  @Delete(':userId')
  @RequireRole('admin')
  @HttpCode(204)
  remove(@CurrentAuth() auth: AuthContext, @Param('workspaceId') workspaceId: string, @Param('userId') userId: string): Promise<void> {
    return this.members.remove(workspaceId, userId, auth.user.id);
  }
}
