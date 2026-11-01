import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import {
  roleSatisfies,
  type CreateTicketViewSchema,
  type TicketViewDto,
  type UpdateTicketViewInput,
  type WorkspaceRole,
} from '@kvitok/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { errors } from '../common/errors';
import { newId } from '../common/ids';
import { json } from '../common/json';
import type { TicketView, User } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { WorkspaceContext } from '../common/request';
import { toUserRef } from './tickets.mapper';

type Caller = WorkspaceContext & { userId: string };

/** Saved queue filters: personal views of each member and views an admin shared with the workspace. */
@Injectable()
export class TicketViewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The caller's views and the shared ones, shared first, each by name. */
  async list(caller: Caller): Promise<TicketViewDto[]> {
    const rows = await this.prisma.ticketView.findMany({
      where: { workspaceId: caller.workspaceId, OR: [{ userId: caller.userId }, { shared: true }] },
      include: { user: true },
      orderBy: [{ shared: 'desc' }, { name: 'asc' }],
    });
    return rows.map((row) => toDto(row, caller));
  }

  async create(caller: Caller, input: z.output<typeof CreateTicketViewSchema>): Promise<TicketViewDto> {
    if (input.shared) assertAdmin(caller.role);
    const row = await this.prisma.ticketView.create({
      data: { id: newId(), workspaceId: caller.workspaceId, userId: caller.userId, name: input.name, shared: input.shared, query: json(input.query) },
      include: { user: true },
    });
    const dto = toDto(row, caller);
    if (row.shared) {
      await this.audit.record({ workspaceId: caller.workspaceId, entity: 'ticket_view', entityId: row.id, action: 'create', after: auditView(dto) });
    }
    return dto;
  }

  async update(caller: Caller, id: string, input: UpdateTicketViewInput): Promise<TicketViewDto> {
    const existing = await this.editable(caller, id);
    if (input.shared !== undefined && input.shared !== existing.shared) assertAdmin(caller.role);
    const row = await this.prisma.ticketView.update({
      where: { id },
      data: { ...input, ...(input.query ? { query: json(input.query) } : {}) },
      include: { user: true },
    });
    const dto = toDto(row, caller);
    if (existing.shared || row.shared) {
      await this.audit.record({
        workspaceId: caller.workspaceId,
        entity: 'ticket_view',
        entityId: id,
        action: 'update',
        before: auditView(toDto(existing, caller)),
        after: auditView(dto),
      });
    }
    return dto;
  }

  async delete(caller: Caller, id: string): Promise<void> {
    const existing = await this.editable(caller, id);
    await this.prisma.ticketView.delete({ where: { id } });
    if (existing.shared) {
      await this.audit.record({ workspaceId: caller.workspaceId, entity: 'ticket_view', entityId: id, action: 'delete', before: auditView(toDto(existing, caller)) });
    }
  }

  /** A view the caller may change: their personal one, or a shared one for an admin. Someone else's personal view is not found. */
  private async editable(caller: Caller, id: string): Promise<TicketView & { user: User }> {
    const row = await this.prisma.ticketView.findFirst({
      where: { id, workspaceId: caller.workspaceId, OR: [{ userId: caller.userId }, { shared: true }] },
      include: { user: true },
    });
    if (row === null) {
      throw errors.notFound(t('api.ticketViewNotFound'));
    }
    if (row.shared) assertAdmin(caller.role);
    return row;
  }
}

function assertAdmin(role: WorkspaceRole): void {
  if (!roleSatisfies(role, 'admin')) {
    throw errors.forbidden(t('api.sharedViewsAdminOnly'));
  }
}

function toDto(row: TicketView & { user: User }, caller: Caller): TicketViewDto {
  return {
    id: row.id,
    name: row.name,
    shared: row.shared,
    query: row.query as Record<string, string>,
    author: toUserRef(row.user),
    editable: row.shared ? roleSatisfies(caller.role, 'admin') : row.userId === caller.userId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The audit log keeps what the team sees, not who is looking. */
function auditView(dto: TicketViewDto): Pick<TicketViewDto, 'name' | 'shared' | 'query'> {
  return { name: dto.name, shared: dto.shared, query: dto.query };
}
