import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import type { CreateDepartmentInput, DepartmentDto, UpdateDepartmentInput } from '@kvitok/shared';
import { currentActor } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import { errors } from '../common/errors';
import { newId } from '../common/ids';
import { isUniqueViolation } from '../common/prisma-errors';
import type { Department, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { NotificationsService } from '../notifications/notifications.service';
import { publishAssigneeChanges, settleEach } from '../tickets/assignment';
import { applyTriageChange, type TriageChange } from '../tickets/department-change';
import { SYSTEM_ACTOR } from '../tickets/ticket-events';
import { triageDepartmentId } from './department-access';

@Injectable()
export class DepartmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(workspaceId: string): Promise<DepartmentDto[]> {
    const rows = await this.prisma.department.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
    return rows.map(toDepartmentDto);
  }

  async create(workspaceId: string, input: CreateDepartmentInput): Promise<DepartmentDto> {
    try {
      const { row, triage } = await this.prisma.$transaction(async (tx) => {
        const before = await triageDepartmentId(tx, workspaceId);
        if (input.isTriage) {
          await tx.department.updateMany({ where: { workspaceId, isTriage: true }, data: { isTriage: false } });
        }
        const row = await tx.department.create({
          data: {
            id: newId(),
            workspaceId,
            key: input.key,
            title: input.title,
            description: input.description ?? '',
            examples: input.examples ?? [],
            instructions: input.instructions ?? '',
            isTriage: input.isTriage ?? false,
            assignmentMode: input.assignmentMode ?? 'manual',
          },
        });
        return { row, triage: await this.applyTriageChange(tx, workspaceId, before) };
      });
      const dto = toDepartmentDto(row);
      await this.audit.record({ workspaceId, entity: 'department', entityId: row.id, action: 'create', after: dto });
      await this.publishTriageChange(workspaceId, triage);
      return dto;
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

    const { row, triage } = await this.prisma.$transaction(async (tx) => {
      const before = await triageDepartmentId(tx, workspaceId);
      if (rest.isTriage) {
        await tx.department.updateMany({ where: { workspaceId, isTriage: true, NOT: { id } }, data: { isTriage: false } });
      }
      const row = await tx.department.update({
        where: { id },
        data: {
          ...rest,
          ...(archived === undefined ? {} : { archivedAt: archived ? (existing.archivedAt ?? new Date()) : null }),
        },
      });
      return { row, triage: await this.applyTriageChange(tx, workspaceId, before) };
    });
    const dto = toDepartmentDto(row);
    await this.audit.record({ workspaceId, entity: 'department', entityId: id, action: 'update', before: toDepartmentDto(existing), after: dto });
    await this.publishTriageChange(workspaceId, triage);
    return dto;
  }

  /** Who sees tickets without a department follows the triage department. */
  private applyTriageChange(tx: Prisma.TransactionClient, workspaceId: string, before: string | null): Promise<TriageChange> {
    return applyTriageChange(tx, workspaceId, before);
  }

  /** After the change commits: the tickets without a department are settled one by one, by the current actor. */
  private async publishTriageChange(workspaceId: string, change: TriageChange): Promise<void> {
    const actor = currentActor();
    const actorId = actor.type === 'system' ? null : actor.userId;
    const changes = await settleEach(this.prisma, change.tickets, actorId ? { type: 'user', id: actorId } : SYSTEM_ACTOR, 'triage_changed');
    await publishAssigneeChanges(this.realtime, this.notifications, workspaceId, changes, actorId);
    for (const ticket of changes) {
      await this.realtime.publish(workspaceId, { type: 'ticket.updated', ticketId: ticket.ticketId });
    }
    for (const userId of change.members) {
      await this.realtime.publish(workspaceId, { type: 'access.changed', userId });
    }
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
    assignmentMode: row.assignmentMode,
    archived: row.archivedAt !== null,
  };
}
