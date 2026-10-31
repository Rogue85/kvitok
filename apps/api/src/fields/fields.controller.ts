import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  CreateFieldDefinitionSchema,
  FieldEntitySchema,
  UpdateFieldDefinitionSchema,
  type CreateFieldDefinitionInput,
  type FieldDefinitionDto,
  type FieldEntity,
  type UpdateFieldDefinitionInput,
} from '@kvitok/shared';
import { RequireScope } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireRole, WorkspaceGuard } from '../workspaces/workspace.guard';
import { FieldsService } from './fields.service';

@Controller('workspaces/:workspaceId/fields')
@UseGuards(WorkspaceGuard)
@RequireScope('config:write')
export class FieldsController {
  constructor(private readonly fields: FieldsService) {}

  @Get()
  list(
    @Param('workspaceId') workspaceId: string,
    @Query('entity', new ZodValidationPipe(FieldEntitySchema.optional())) entity?: FieldEntity,
  ): Promise<FieldDefinitionDto[]> {
    return this.fields.list(workspaceId, entity);
  }

  @Post()
  @RequireRole('admin')
  create(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreateFieldDefinitionSchema)) body: CreateFieldDefinitionInput,
  ): Promise<FieldDefinitionDto> {
    return this.fields.create(workspaceId, body);
  }

  @Patch(':fieldId')
  @RequireRole('admin')
  update(
    @Param('workspaceId') workspaceId: string,
    @Param('fieldId') fieldId: string,
    @Body(new ZodValidationPipe(UpdateFieldDefinitionSchema)) body: UpdateFieldDefinitionInput,
  ): Promise<FieldDefinitionDto> {
    return this.fields.update(workspaceId, fieldId, body);
  }
}
