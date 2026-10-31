import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import type { ReplyDraftDto } from '@kvitok/shared';
import { errors } from '../common/errors';
import { newId } from '../common/ids';
import type { Prisma, ReplyDraft } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';

type Db = Prisma.TransactionClient;

/**
 * Versioned reply drafts. The current one is what the composer shows.
 * If the operator has edits of their own, a new agent version does not replace them but waits as suggested.
 */
@Injectable()
export class DraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async state(ticketId: string, db: Db = this.prisma): Promise<{ draft: ReplyDraft | null; suggested: ReplyDraft | null }> {
    const rows = await db.replyDraft.findMany({ where: { ticketId, status: { in: ['current', 'suggested'] } }, orderBy: { version: 'desc' } });
    return { draft: rows.find((d) => d.status === 'current') ?? null, suggested: rows.find((d) => d.status === 'suggested') ?? null };
  }

  /** A version from the agent: if the current draft is an operator edit, store it alongside as suggested. */
  async addAgentDraft(db: Db, params: { workspaceId: string; ticketId: string; runId: string; bodyHtml: string; revision: number; force?: boolean }): Promise<ReplyDraft> {
    const { draft } = await this.state(params.ticketId, db);
    const operatorEditing = draft?.source === 'operator' && !params.force;
    await db.replyDraft.updateMany({
      where: { ticketId: params.ticketId, status: operatorEditing ? 'suggested' : { in: ['current', 'suggested'] } },
      data: { status: 'superseded' },
    });
    return db.replyDraft.create({
      data: {
        id: newId(),
        workspaceId: params.workspaceId,
        ticketId: params.ticketId,
        version: await this.nextVersion(db, params.ticketId),
        source: 'agent',
        runId: params.runId,
        bodyHtml: params.bodyHtml,
        basedOnRevision: params.revision,
        status: operatorEditing ? 'suggested' : 'current',
      },
    });
  }

  /** Autosave from the composer. Empty text resets the operator's draft. */
  async saveOperatorDraft(workspaceId: string, ticketId: string, userId: string, bodyHtml: string): Promise<ReplyDraft | null> {
    const saved = await this.prisma.$transaction(async (tx) => {
      const { draft } = await this.state(ticketId, tx);
      const ticket = await tx.ticket.findUniqueOrThrow({ where: { id: ticketId } });
      const empty = bodyHtml.replace(/<[^>]*>/g, '').trim() === '';

      if (draft?.bodyHtml === bodyHtml) return draft;
      if (empty) {
        if (draft?.source === 'operator') {
          await tx.replyDraft.update({ where: { id: draft.id }, data: { status: 'discarded' } });
        }
        return null;
      }
      if (draft?.source === 'operator') {
        return tx.replyDraft.update({ where: { id: draft.id }, data: { bodyHtml, userId, basedOnRevision: ticket.revision } });
      }
      if (draft) {
        await tx.replyDraft.update({ where: { id: draft.id }, data: { status: 'superseded' } });
      }
      return tx.replyDraft.create({
        data: {
          id: newId(),
          workspaceId,
          ticketId,
          version: await this.nextVersion(tx, ticketId),
          source: 'operator',
          userId,
          bodyHtml,
          basedOnRevision: ticket.revision,
          status: 'current',
        },
      });
    });
    return saved;
  }

  async acceptSuggested(workspaceId: string, ticketId: string, draftId: string): Promise<ReplyDraft> {
    const accepted = await this.prisma.$transaction(async (tx) => {
      const suggested = await tx.replyDraft.findFirst({ where: { id: draftId, ticketId, workspaceId, status: 'suggested' } });
      if (suggested === null) throw errors.notFound(t('api.suggestedDraftNotFound'));
      await tx.replyDraft.updateMany({ where: { ticketId, status: 'current' }, data: { status: 'superseded' } });
      return tx.replyDraft.update({ where: { id: draftId }, data: { status: 'current' } });
    });
    await this.realtime.publish(workspaceId, { type: 'ticket.updated', ticketId });
    return accepted;
  }

  async discardSuggested(workspaceId: string, ticketId: string, draftId: string): Promise<void> {
    const result = await this.prisma.replyDraft.updateMany({ where: { id: draftId, ticketId, workspaceId, status: 'suggested' }, data: { status: 'discarded' } });
    if (result.count === 0) throw errors.notFound(t('api.suggestedDraftNotFound'));
  }

  /** The reply was sent: the current draft is gone and the suggested version is no longer relevant. */
  async markSent(db: Db, ticketId: string): Promise<void> {
    await db.replyDraft.updateMany({ where: { ticketId, status: 'current' }, data: { status: 'sent' } });
    await db.replyDraft.updateMany({ where: { ticketId, status: 'suggested' }, data: { status: 'superseded' } });
  }

  private async nextVersion(db: Db, ticketId: string): Promise<number> {
    const last = await db.replyDraft.findFirst({ where: { ticketId }, orderBy: { version: 'desc' }, select: { version: true } });
    return (last?.version ?? 0) + 1;
  }
}

export function toDraftDto(draft: ReplyDraft | null): ReplyDraftDto | null {
  return draft
    ? {
        id: draft.id,
        version: draft.version,
        source: draft.source,
        status: draft.status,
        bodyHtml: draft.bodyHtml,
        runId: draft.runId,
        createdAt: draft.createdAt.toISOString(),
      }
    : null;
}
