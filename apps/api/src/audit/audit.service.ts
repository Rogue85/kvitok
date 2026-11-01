import { Injectable } from '@nestjs/common';
import type { AuditAction, AuditActorType, AuditEntity, AuditLogDto, AuditQuery } from '@kvitok/shared';
import { newId } from '../common/ids';
import { json } from '../common/json';
import { stableStringify } from '../common/stable-json';
import type { AuditLog, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { currentActor } from './audit-context';

export interface AuditEntry {
  workspaceId: string | null;
  entity: AuditEntity;
  entityId: string | null;
  action: AuditAction;
  /** The entity as the API shows it. Never pass secrets: a changed secret is a flag such as `apiKeyChanged: true`. */
  before?: object | null;
  after?: object | null;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Records a change on behalf of the current actor. An update that changed nothing is not recorded. */
  async record(entry: AuditEntry, db: Pick<Prisma.TransactionClient, 'auditLog'> = this.prisma): Promise<void> {
    const before = entry.before ?? null;
    const after = entry.after ?? null;
    if (entry.action === 'update' && before !== null && after !== null && stableStringify(before) === stableStringify(after)) {
      return;
    }
    const actor = currentActor();
    await db.auditLog.create({
      data: {
        id: newId(),
        workspaceId: entry.workspaceId,
        actorType: actor.type,
        actorUserId: actor.type === 'system' ? null : actor.userId,
        actorTokenId: actor.type === 'token' ? actor.tokenId : null,
        actorName: actor.type === 'system' ? null : actor.name,
        tokenName: actor.type === 'token' ? actor.tokenName : null,
        entity: entry.entity,
        entityId: entry.entityId,
        action: entry.action,
        ...(before === null ? {} : { before: json(before) }),
        ...(after === null ? {} : { after: json(after) }),
      },
    });
  }

  async list(workspaceId: string, query: AuditQuery): Promise<AuditLogDto[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        workspaceId,
        ...(query.entity ? { entity: query.entity } : {}),
        ...(query.entityId ? { entityId: query.entityId } : {}),
      },
      // A cursor by id: the database compares the exact time, which is finer than the milliseconds of an ISO string.
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
    });
    return rows.map(toAuditLogDto);
  }
}

export function toAuditLogDto(row: AuditLog): AuditLogDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    entity: row.entity as AuditEntity,
    entityId: row.entityId,
    action: row.action as AuditAction,
    actor: { type: row.actorType as AuditActorType, userId: row.actorUserId, name: row.actorName, tokenName: row.tokenName },
    before: row.before as Record<string, unknown> | null,
    after: row.after as Record<string, unknown> | null,
    createdAt: row.createdAt.toISOString(),
  };
}
