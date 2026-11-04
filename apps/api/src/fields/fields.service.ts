import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import {
  type CreateFieldDefinitionInput,
  type FieldAgentOptionsMode,
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
import { json } from '../common/json';
import type { FieldDefinition, OptionSet } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Db = Pick<PrismaService, 'fieldDefinition'>;
type FieldRow = FieldDefinition & { optionSet: OptionSet | null };
const WITH_SET = { optionSet: true } as const;

@Injectable()
export class FieldsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(workspaceId: string, entity?: FieldEntity, db: Db = this.prisma): Promise<FieldDefinitionDto[]> {
    const rows = await db.fieldDefinition.findMany({
      where: { workspaceId, ...(entity ? { entity } : {}) },
      include: WITH_SET,
      orderBy: [{ entity: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(toFieldDefinitionDto);
  }

  async create(workspaceId: string, input: CreateFieldDefinitionInput & { entity: FieldEntity }): Promise<FieldDefinitionDto> {
    const optionSetId = input.optionSetId ?? null;
    if (optionSetId !== null) {
      await this.optionSet(workspaceId, optionSetId);
    }
    try {
      const row = await this.prisma.fieldDefinition.create({
        include: WITH_SET,
        data: {
          id: newId(),
          workspaceId,
          entity: input.entity,
          key: input.key,
          label: input.label,
          type: input.type,
          // A bound field takes the set's options; its own list stays empty.
          options: optionSetId === null ? (input.options ?? []) : [],
          optionSetId,
          agentOptionsMode: input.agentOptionsMode ?? 'auto',
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
    const existing = await this.prisma.fieldDefinition.findFirst({ where: { id, workspaceId }, include: WITH_SET });
    if (existing === null) {
      throw errors.notFound(t('api.fieldNotFound'));
    }
    const { archived, optionSetId, ...rest } = input;
    const isList = existing.type === 'select' || existing.type === 'multiselect';
    const nextSetId = optionSetId === undefined ? existing.optionSetId : optionSetId;
    if (nextSetId !== null && !isList) {
      throw errors.validation([{ path: 'optionSetId', message: t('validation.optionSetSelectOnly'), code: 'custom' }]);
    }
    if (optionSetId && optionSetId !== existing.optionSetId) {
      await this.optionSet(workspaceId, optionSetId);
    }
    let options: FieldOption[] | undefined = rest.options;
    if (nextSetId !== null) {
      options = [];
    } else if (existing.optionSet !== null && options === undefined) {
      // Unbinding without a new list: the field keeps the set's options as its own.
      options = existing.optionSet.options as FieldOption[];
    }
    if (isList && nextSetId === null && (options ?? (existing.options as FieldOption[])).length === 0) {
      throw errors.validation([{ path: 'options', message: t('validation.optionsRequired'), code: 'custom' }]);
    }

    const row = await this.prisma.fieldDefinition.update({
      where: { id },
      include: WITH_SET,
      data: {
        ...rest,
        ...(options === undefined ? {} : { options: json(options) }),
        ...(optionSetId === undefined ? {} : { optionSetId }),
        ...(archived === undefined ? {} : { archivedAt: archived ? (existing.archivedAt ?? new Date()) : null }),
      },
    });
    const dto = toFieldDefinitionDto(row);
    await this.audit.record({ workspaceId, entity: 'field', entityId: id, action: 'update', before: toFieldDefinitionDto(existing), after: dto });
    return dto;
  }

  private async optionSet(workspaceId: string, id: string): Promise<OptionSet> {
    const set = await this.prisma.optionSet.findFirst({ where: { id, workspaceId } });
    if (set === null) {
      throw errors.validation([{ path: 'optionSetId', message: t('api.optionSetNotFound'), code: 'custom' }]);
    }
    return set;
  }
}

/** A bound field shows the set's options (archived ones included and flagged). */
export function toFieldDefinitionDto(row: FieldRow): FieldDefinitionDto {
  const set = row.optionSet;
  return {
    id: row.id,
    entity: row.entity,
    key: row.key,
    label: row.label,
    type: row.type,
    options: (set ? set.options : row.options) as FieldOption[],
    validation: row.validation as FieldValidation,
    agentHint: row.agentHint,
    fillMode: row.fillMode,
    agentMinConfidence: row.agentMinConfidence,
    requiredOn: row.requiredOn as FieldDefinitionDto['requiredOn'],
    scopeDepartmentIds: row.scopeDepartmentIds,
    display: row.display as FieldDefinitionDto['display'],
    passToIntegration: row.passToIntegration,
    position: row.position,
    optionSet: set
      ? { id: set.id, integrationId: set.integrationId, name: set.name, title: set.title, description: set.description, removed: set.removedAt !== null }
      : null,
    agentOptionsMode: row.agentOptionsMode as FieldAgentOptionsMode,
    archived: row.archivedAt !== null,
  };
}
