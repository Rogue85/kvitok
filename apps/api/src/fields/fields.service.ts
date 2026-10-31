import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import {
  type CreateFieldDefinitionInput,
  type FieldDefinitionDto,
  type FieldEntity,
  type FieldOption,
  type FieldValidation,
  type UpdateFieldDefinitionInput,
} from '@kvitok/shared';
import { AuditService } from '../audit/audit.service';
import { errors } from '../common/errors';
import { newId } from '../common/ids';
import { isUniqueViolation } from '../common/prisma-errors';
import type { FieldDefinition } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Db = Pick<PrismaService, 'fieldDefinition'>;

@Injectable()
export class FieldsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(workspaceId: string, entity?: FieldEntity, db: Db = this.prisma): Promise<FieldDefinitionDto[]> {
    const rows = await db.fieldDefinition.findMany({
      where: { workspaceId, ...(entity ? { entity } : {}) },
      orderBy: [{ entity: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(toFieldDefinitionDto);
  }

  async create(workspaceId: string, input: CreateFieldDefinitionInput & { entity: FieldEntity }): Promise<FieldDefinitionDto> {
    try {
      const row = await this.prisma.fieldDefinition.create({
        data: {
          id: newId(),
          workspaceId,
          entity: input.entity,
          key: input.key,
          label: input.label,
          type: input.type,
          options: input.options ?? [],
          validation: input.validation ?? {},
          agentHint: input.agentHint ?? '',
          fillMode: input.fillMode ?? 'manual',
          agentMinConfidence: input.agentMinConfidence ?? 0.8,
          requiredOn: input.requiredOn ?? [],
          scopeDepartmentIds: input.scopeDepartmentIds ?? [],
          display: input.display ?? ['sidebar'],
          passToIntegration: input.passToIntegration ?? false,
          position: input.position ?? 0,
        },
      });
      const dto = toFieldDefinitionDto(row);
      await this.audit.record({ workspaceId, entity: 'field', entityId: row.id, action: 'create', after: dto });
      return dto;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw errors.conflict(t('api.fieldKeyExists', { key: input.key }));
      }
      throw error;
    }
  }

  async update(workspaceId: string, id: string, input: UpdateFieldDefinitionInput): Promise<FieldDefinitionDto> {
    const existing = await this.prisma.fieldDefinition.findFirst({ where: { id, workspaceId } });
    if (existing === null) {
      throw errors.notFound(t('api.fieldNotFound'));
    }
    const { archived, ...rest } = input;
    const nextOptions = rest.options ?? (existing.options as FieldOption[]);
    if ((existing.type === 'select' || existing.type === 'multiselect') && nextOptions.length === 0) {
      throw errors.validation([{ path: 'options', message: t('validation.optionsRequired'), code: 'custom' }]);
    }

    const row = await this.prisma.fieldDefinition.update({
      where: { id },
      data: {
        ...rest,
        ...(archived === undefined ? {} : { archivedAt: archived ? (existing.archivedAt ?? new Date()) : null }),
      },
    });
    const dto = toFieldDefinitionDto(row);
    await this.audit.record({ workspaceId, entity: 'field', entityId: id, action: 'update', before: toFieldDefinitionDto(existing), after: dto });
    return dto;
  }
}

export function toFieldDefinitionDto(row: FieldDefinition): FieldDefinitionDto {
  return {
    id: row.id,
    entity: row.entity,
    key: row.key,
    label: row.label,
    type: row.type,
    options: row.options as FieldOption[],
    validation: row.validation as FieldValidation,
    agentHint: row.agentHint,
    fillMode: row.fillMode,
    agentMinConfidence: row.agentMinConfidence,
    requiredOn: row.requiredOn as FieldDefinitionDto['requiredOn'],
    scopeDepartmentIds: row.scopeDepartmentIds,
    display: row.display as FieldDefinitionDto['display'],
    passToIntegration: row.passToIntegration,
    position: row.position,
    archived: row.archivedAt !== null,
  };
}
