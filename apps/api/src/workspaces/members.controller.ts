import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import {
  AddMemberSchema,
  UpdateMemberSchema,
  type AddMemberInput,
  type AddMemberResult,
  type MemberCandidateDto,
  type MemberDto,
  type PasswordLinkDto,
  type UpdateMemberInput,
} from '@kvitok/shared';
import { CurrentAuth } from '../auth/decorators';
import type { AuthContext } from '../common/request';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { MembersService } from './members.service';
import { RequireRole, WorkspaceGuard } from './workspace.guard';

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

  @Delete(':userId')
  @RequireRole('admin')
  @HttpCode(204)
  remove(@Param('workspaceId') workspaceId: string, @Param('userId') userId: string): Promise<void> {
    return this.members.remove(workspaceId, userId);
  }
}
