import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import {
  AddMemberSchema,
  UpdateMemberSchema,
  type AddMemberInput,
  type MemberDto,
  type UpdateMemberInput,
} from '@kvitok/shared';
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

  @Post()
  @RequireRole('admin')
  add(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(AddMemberSchema)) body: AddMemberInput,
  ): Promise<MemberDto> {
    return this.members.add(workspaceId, body);
  }

  @Patch(':userId')
  @RequireRole('admin')
  update(
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(UpdateMemberSchema)) body: UpdateMemberInput,
  ): Promise<MemberDto> {
    return this.members.updateRole(workspaceId, userId, body.role);
  }

  @Delete(':userId')
  @RequireRole('admin')
  @HttpCode(204)
  remove(@Param('workspaceId') workspaceId: string, @Param('userId') userId: string): Promise<void> {
    return this.members.remove(workspaceId, userId);
  }
}
