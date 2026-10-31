import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import {
  CreateDepartmentSchema,
  UpdateDepartmentSchema,
  type CreateDepartmentInput,
  type DepartmentDto,
  type UpdateDepartmentInput,
} from '@kvitok/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireRole, WorkspaceGuard } from '../workspaces/workspace.guard';
import { DepartmentsService } from './departments.service';

@Controller('workspaces/:workspaceId/departments')
@UseGuards(WorkspaceGuard)
export class DepartmentsController {
  constructor(private readonly departments: DepartmentsService) {}

  @Get()
  list(@Param('workspaceId') workspaceId: string): Promise<DepartmentDto[]> {
    return this.departments.list(workspaceId);
  }

  @Post()
  @RequireRole('admin')
  create(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreateDepartmentSchema)) body: CreateDepartmentInput,
  ): Promise<DepartmentDto> {
    return this.departments.create(workspaceId, body);
  }

  @Patch(':departmentId')
  @RequireRole('admin')
  update(
    @Param('workspaceId') workspaceId: string,
    @Param('departmentId') departmentId: string,
    @Body(new ZodValidationPipe(UpdateDepartmentSchema)) body: UpdateDepartmentInput,
  ): Promise<DepartmentDto> {
    return this.departments.update(workspaceId, departmentId, body);
  }
}
