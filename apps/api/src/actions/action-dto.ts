import type { ActionProposalDto, ActionSource, ActionStatus } from '@kvitok/shared';
import type { ActionProposal, Integration, User } from '../generated/prisma/client';

export type ActionWithRelations = ActionProposal & {
  integration: Pick<Integration, 'name'>;
  decidedBy: Pick<User, 'id' | 'name'> | null;
  createdBy: Pick<User, 'id' | 'name'> | null;
};

export const ACTION_INCLUDE = {
  integration: { select: { name: true } },
  decidedBy: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
} as const;

export function toActionDto(row: ActionWithRelations): ActionProposalDto {
  return {
    id: row.id,
    runId: row.runId,
    source: row.source as ActionSource,
    createdBy: row.createdBy,
    replacedById: row.replacedById,
    refreshDraft: row.refreshDraft,
    integrationId: row.integrationId,
    integrationName: row.integration.name,
    action: row.action,
    title: row.title,
    params: row.params as Record<string, unknown>,
    normalizedParams: (row.normalizedParams as Record<string, unknown> | null) ?? null,
    preview: row.preview,
    warnings: (row.warnings as string[]) ?? [],
    reason: row.reason,
    calculation: row.calculation,
    status: row.status as ActionStatus,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionComment: row.decisionComment,
    executedAt: row.executedAt?.toISOString() ?? null,
    result: row.result ?? null,
    externalRef: row.externalRef,
    error: row.error,
    attempts: row.attempts,
    createdAt: row.createdAt.toISOString(),
  };
}
