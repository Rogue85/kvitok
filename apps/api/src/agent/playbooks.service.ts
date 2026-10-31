import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import type { CreatePlaybookInput, PlaybookDto, UpdatePlaybookInput } from '@kvitok/shared';
import { AuditService } from '../audit/audit.service';
import { errors } from '../common/errors';
import { newId } from '../common/ids';
import { isUniqueViolation } from '../common/prisma-errors';
import type { Playbook } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PlaybooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(workspaceId: string): Promise<PlaybookDto[]> {
    const rows = await this.prisma.playbook.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
    return rows.map(toPlaybookDto);
  }

  async create(workspaceId: string, input: CreatePlaybookInput): Promise<PlaybookDto> {
    try {
      const row = await this.prisma.playbook.create({
        data: {
          id: newId(),
          workspaceId,
          key: input.key,
          title: input.title,
          when: input.when,
          body: input.body,
          departmentId: input.departmentId ?? null,
          enabled: input.enabled ?? true,
        },
      });
      const dto = toPlaybookDto(row);
      await this.audit.record({ workspaceId, entity: 'playbook', entityId: row.id, action: 'create', after: dto });
      return dto;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw errors.conflict(t('api.playbookKeyExists', { key: input.key }));
      }
      throw error;
    }
  }

  async update(workspaceId: string, id: string, input: UpdatePlaybookInput): Promise<PlaybookDto> {
    const existing = await this.prisma.playbook.findFirst({ where: { id, workspaceId } });
    if (existing === null) {
      throw errors.notFound(t('api.playbookNotFound'));
    }
    if (existing.source === 'manifest' && Object.keys(input).some((key) => key !== 'enabled' && input[key as keyof UpdatePlaybookInput] !== undefined)) {
      throw errors.conflict(t('api.playbookFromIntegrationEdit'));
    }
    const contentChanged = (['title', 'when', 'body', 'departmentId'] as const).some(
      (key) => input[key] !== undefined && input[key] !== existing[key],
    );
    const row = await this.prisma.playbook.update({
      where: { id },
      data: { ...input, ...(contentChanged ? { version: { increment: 1 } } : {}) },
    });
    const dto = toPlaybookDto(row);
    await this.audit.record({ workspaceId, entity: 'playbook', entityId: id, action: 'update', before: toPlaybookDto(existing), after: dto });
    return dto;
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    const existing = await this.prisma.playbook.findFirst({ where: { id, workspaceId } });
    if (existing?.source === 'manifest') {
      throw errors.conflict(t('api.playbookFromIntegrationDelete'));
    }
    const deleted = await this.prisma.playbook.deleteMany({ where: { id, workspaceId } });
    if (existing === null || deleted.count === 0) {
      throw errors.notFound(t('api.playbookNotFound'));
    }
    await this.audit.record({ workspaceId, entity: 'playbook', entityId: id, action: 'delete', before: toPlaybookDto(existing) });
  }
}

export function toPlaybookDto(row: Playbook): PlaybookDto {
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    when: row.when,
    body: row.body,
    departmentId: row.departmentId,
    source: row.source,
    integrationId: row.integrationId,
    enabled: row.enabled,
    version: row.version,
  };
}
