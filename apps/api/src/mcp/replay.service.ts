import { t } from '@kvitok/i18n';
import { Injectable } from '@nestjs/common';
import { AgentEngine } from '../agent/agent-engine';
import type { AgentTrigger } from '../agent/agent-trigger.types';
import type { IntegrationStepInput } from '../agent/integration-runtime';
import type { AgentResult } from '../agent/submit-schema';
import { errors } from '../common/errors';
import { Prisma, type AgentRun, type AgentStep } from '../generated/prisma/client';
import { htmlToPlainText } from '../mail/html';
import { PrismaService } from '../prisma/prisma.service';
import { textSimilarity } from './quality-report.service';

const MAX_REPLY_CHARS = 1500;

interface Proposal {
  action: string;
  params: unknown;
}

export interface ReplayComparison {
  ticket: { id: string; number: number };
  pastRun: { id: string; configVersion: number | null; createdAt: string };
  replayRun: { id: string; configVersion: number | null; status: string; error: string | null; cost: number | null };
  department: { before: string | null; after: string | null; operatorFinal: string | null };
  confidence: { before: number | null; after: number | null };
  needsHuman: { before: boolean | null; after: boolean | null };
  actions: {
    before: Array<Proposal & { operatorDecision: string | null }>;
    after: Proposal[];
  };
  fields: { before: Record<string, unknown>; after: Record<string, unknown> };
  reply: {
    before: string;
    after: string;
    /** 1 — the same text. */
    similarity: number;
    /** How close each draft is to what the operator actually sent after the past run. */
    toSentReply: { before: number; after: number } | null;
  };
  messageToOperator: string | null;
}

/** Replays past runs with the current configuration and compares the outcome; nothing is applied to the tickets. */
@Injectable()
export class ReplayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: AgentEngine,
  ) {}

  /** The run to replay: the given one or the ticket's last applied, non-trial run. */
  async pastRun(workspaceId: string, ticketId: string, runId?: string): Promise<AgentRun> {
    const run = await this.prisma.agentRun.findFirst({
      where: runId ? { id: runId, workspaceId, ticketId } : { workspaceId, ticketId, status: 'applied', dryRun: false, inputSnapshot: { not: Prisma.DbNull } },
      orderBy: { createdAt: 'desc' },
    });
    if (run === null) throw errors.notFound(t('api.runNotFound'));
    return run;
  }

  async replay(workspaceId: string, past: AgentRun): Promise<ReplayComparison> {
    const ticket = await this.prisma.ticket.findFirstOrThrow({ where: { id: past.ticketId, workspaceId } });
    const { run } = await this.engine.execute({
      ticketId: ticket.id,
      mode: past.mode,
      triggers: [past.trigger as unknown as AgentTrigger],
      inputRevision: ticket.revision,
      replayOf: past.id,
    });

    const [runs, departments, decisions, sent] = await Promise.all([
      this.prisma.agentRun.findMany({
        where: { id: { in: [past.id, run.id] } },
        include: { configVersion: { select: { number: true } }, steps: { where: { kind: 'tool', error: null }, orderBy: { index: 'asc' } } },
      }),
      this.prisma.department.findMany({ where: { workspaceId }, select: { id: true, key: true } }),
      this.prisma.actionProposal.findMany({ where: { runId: past.id } }),
      this.prisma.message.findFirst({
        where: { ticketId: ticket.id, authorType: 'operator', visibility: 'public', createdAt: { gt: past.createdAt } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const before = runs.find((r) => r.id === past.id)!;
    const after = runs.find((r) => r.id === run.id)!;
    const beforeResult = (before.output ?? null) as AgentResult | null;
    const afterResult = (after.output ?? null) as AgentResult | null;
    const beforeReply = beforeResult?.reply?.body ? htmlToPlainText(beforeResult.reply.body) : '';
    const afterReply = afterResult?.reply?.body ? htmlToPlainText(afterResult.reply.body) : '';

    return {
      ticket: { id: ticket.id, number: ticket.number },
      pastRun: { id: before.id, configVersion: before.configVersion?.number ?? null, createdAt: before.createdAt.toISOString() },
      replayRun: { id: after.id, configVersion: after.configVersion?.number ?? null, status: after.status, error: after.error, cost: after.cost },
      department: {
        before: beforeResult?.department ?? null,
        after: afterResult?.department ?? null,
        operatorFinal: departments.find((d) => d.id === ticket.departmentId)?.key ?? null,
      },
      confidence: { before: beforeResult?.confidence ?? null, after: afterResult?.confidence ?? null },
      needsHuman: { before: beforeResult?.needs_human ?? null, after: afterResult?.needs_human ?? null },
      actions: {
        before: proposalsOf(before.steps).map((p) => ({
          ...p,
          operatorDecision:
            decisions.find((d) => d.action === p.action && (sameParams(d.normalizedParams, p.params) || sameParams(d.params, p.params)))?.status ?? null,
        })),
        after: proposalsOf(after.steps),
      },
      fields: { before: fieldValues(beforeResult), after: fieldValues(afterResult) },
      reply: {
        before: clip(beforeReply),
        after: clip(afterReply),
        similarity: round(textSimilarity(beforeReply, afterReply)),
        toSentReply: sent ? { before: round(textSimilarity(beforeReply, sent.bodyText)), after: round(textSimilarity(afterReply, sent.bodyText)) } : null,
      },
      messageToOperator: afterResult?.message_to_operator || null,
    };
  }
}

/** Proposals the backend accepted in validate — these reach the operator. */
function proposalsOf(steps: AgentStep[]): Proposal[] {
  return steps.flatMap((step) => {
    const input = step.input as IntegrationStepInput | null;
    const output = step.output as { ok?: boolean; normalized_params?: unknown } | null;
    if (input?.call !== 'validate' || !input.action || output?.ok !== true) return [];
    return [{ action: input.action, params: output.normalized_params ?? input.args ?? {} }];
  });
}

function fieldValues(result: AgentResult | null): Record<string, unknown> {
  return Object.fromEntries(Object.entries(result?.fields ?? {}).map(([key, field]) => [key, field.value]));
}

function sameParams(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function clip(text: string): string {
  return text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}…` : text;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
