import { Body, Controller, Delete, Get, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import {
  CreateUserSchema,
  SetMembershipSchema,
  UpdateUserSchema,
  type AdminUserDto,
  type AuditLogDto,
  type CreateUserInput,
  type PasswordLinkDto,
  type SetMembershipInput,
  type UpdateUserInput,
} from '@kvitok/shared';
import { CurrentAuth } from '../auth/decorators';
import type { AuthContext } from '../common/request';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { SuperadminGuard } from './superadmin.guard';
import { UsersAdminService } from './users-admin.service';

@Controller('admin/users')
@UseGuards(SuperadminGuard)
export class UsersAdminController {
  constructor(private readonly users: UsersAdminService) {}

  @Get()
  list(): Promise<AdminUserDto[]> {
    return this.users.list();
  }

  @Post()
  create(@Body(new ZodValidationPipe(CreateUserSchema)) body: CreateUserInput): Promise<{ user: AdminUserDto; link: PasswordLinkDto }> {
    return this.users.create(body);
  }

  @Get(':userId')
  get(@Param('userId') userId: string): Promise<AdminUserDto> {
    return this.users.get(userId);
  }

  @Patch(':userId')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(UpdateUserSchema)) body: UpdateUserInput,
  ): Promise<AdminUserDto> {
    return this.users.update(auth, userId, body);
  }

  @Post(':userId/password-link')
  passwordLink(@Param('userId') userId: string): Promise<PasswordLinkDto> {
    return this.users.passwordLink(userId);
  }

  @Get(':userId/history')
  history(@Param('userId') userId: string): Promise<AuditLogDto[]> {
    return this.users.history(userId);
  }

  @Put(':userId/memberships/:workspaceId')
  setMembership(
    @CurrentAuth() auth: AuthContext,
    @Param('userId') userId: string,
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(SetMembershipSchema)) body: SetMembershipInput,
  ): Promise<AdminUserDto> {
    return this.users.setMembership(userId, workspaceId, body, auth.user.id);
  }

  @Delete(':userId/memberships/:workspaceId')
  removeMembership(@Param('userId') userId: string, @Param('workspaceId') workspaceId: string): Promise<AdminUserDto> {
    return this.users.removeMembership(userId, workspaceId);
  }
}
