import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import type { CreateDepartmentInput, DepartmentDto, UpdateDepartmentInput } from '@kvitok/shared';
import { errors } from '../common/errors';
import { newId } from '../common/ids';
import { isUniqueViolation } from '../common/prisma-errors';
import type { Department } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DepartmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(workspaceId: string): Promise<DepartmentDto[]> {
    const rows = await this.prisma.department.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
    return rows.map(toDepartmentDto);
  }

  async create(workspaceId: string, input: CreateDepartmentInput): Promise<DepartmentDto> {
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        if (input.isTriage) {
          await tx.department.updateMany({ where: { workspaceId, isTriage: true }, data: { isTriage: false } });
        }
        return tx.department.create({
          data: {
            id: newId(),
            workspaceId,
            key: input.key,
            title: input.title,
            description: input.description ?? '',
            examples: input.examples ?? [],
            instructions: input.instructions ?? '',
            isTriage: input.isTriage ?? false,
          },
        });
      });
      return toDepartmentDto(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw errors.conflict(t('api.departmentKeyExists', { key: input.key }));
      }
      throw error;
    }
  }

  async update(workspaceId: string, id: string, input: UpdateDepartmentInput): Promise<DepartmentDto> {
    const existing = await this.prisma.department.findFirst({ where: { id, workspaceId } });
    if (existing === null) {
      throw errors.notFound(t('api.departmentNotFound'));
    }
    const { archived, ...rest } = input;

    const row = await this.prisma.$transaction(async (tx) => {
      if (rest.isTriage) {
        await tx.department.updateMany({ where: { workspaceId, isTriage: true, NOT: { id } }, data: { isTriage: false } });
      }
      return tx.department.update({
        where: { id },
        data: {
          ...rest,
          ...(archived === undefined ? {} : { archivedAt: archived ? (existing.archivedAt ?? new Date()) : null }),
        },
      });
    });
    return toDepartmentDto(row);
  }

  /** A department of this workspace and not archived — otherwise 422. */
  async assertAssignable(workspaceId: string, id: string): Promise<Department> {
    const department = await this.prisma.department.findFirst({ where: { id, workspaceId, archivedAt: null } });
    if (department === null) {
      throw errors.validation([{ path: 'departmentId', message: t('api.departmentNotFoundOrArchived'), code: 'custom' }]);
    }
    return department;
  }
}

export function toDepartmentDto(row: Department): DepartmentDto {
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    description: row.description,
    examples: row.examples,
    instructions: row.instructions,
    isTriage: row.isTriage,
    archived: row.archivedAt !== null,
  };
}
