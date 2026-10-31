import { Injectable } from '@nestjs/common';
import type { TicketAnalysis } from '@kvitok/shared';
import { htmlToPlainText } from '../mail/html';
import { PrismaService } from '../prisma/prisma.service';

const MAX_EXAMPLES = 10;
/** Words compared per reply: enough to tell an edit from a rewrite. */
const MAX_WORDS = 400;
const UNCHANGED = 0.95;
const REWRITTEN = 0.6;

interface TicketRef {
  id: string;
  number: number;
}

interface Tally {
  tickets: number;
  departmentOverrides: number;
  rejectedActions: number;
  rewrittenReplies: number;
}

export interface QualityReport {
  period: { from: string; to: string; days: number };
  runs: {
    total: number;
    byStatus: Record<string, number>;
    byConfigVersion: Record<string, number>;
    tokensIn: number;
    tokensOut: number;
    /** In the workspace currency. */
    cost: number;
    currency: string;
    avgDurationMs: number | null;
    failures: Array<TicketRef & { runId: string; error: string }>;
  };
  tickets: { analyzed: number; needsHuman: number; sentToTriage: number };
  /** An operator moved the ticket to another department after the agent picked one. */
  departmentOverrides: Array<TicketRef & { agentChose: string | null; from: string | null; to: string | null }>;
  actions: {
    byAction: Record<string, Record<string, number>>;
    rejected: Array<TicketRef & { action: string; params: unknown; reason: string; comment: string | null }>;
  };
  /** Sent replies compared with the agent's last draft before them. */
  replies: {
    sent: number;
    withoutAgentDraft: number;
    unchanged: number;
    edited: number;
    rewritten: number;
    rewrittenExamples: Array<TicketRef & { similarity: number }>;
  };
  questions: { asked: number; examples: Array<TicketRef & { text: string }> };
  byDepartment: Record<string, Tally>;
  byPlaybook: Record<string, Tally>;
}

/** Where operators corrected the agent: the signals for tuning its instructions. */
@Injectable()
export class QualityReportService {
  constructor(private readonly prisma: PrismaService) {}

  /** `from` — the start of the period when it is not just `days` back from now (analytics counts whole days). */
  async report(workspaceId: string, options: { days: number; departmentId?: string; from?: Date }): Promise<QualityReport> {
    const to = new Date();
    const from = options.from ?? new Date(to.getTime() - options.days * 24 * 60 * 60 * 1000);
    const runs = await this.prisma.agentRun.findMany({
      where: { workspaceId, dryRun: false, createdAt: { gte: from }, ...(options.departmentId ? { ticket: { departmentId: options.departmentId } } : {}) },
      select: {
        id: true,
        ticketId: true,
        status: true,
        error: true,
        tokensIn: true,
        tokensOut: true,
        cost: true,
        startedAt: true,
        finishedAt: true,
        configVersion: { select: { number: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    const ticketIds = [...new Set(runs.map((r) => r.ticketId))];
    const [workspace, tickets, departments, overrides, proposals, replies, questions] = await Promise.all([
      this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { currency: true } }),
      this.prisma.ticket.findMany({ where: { id: { in: ticketIds } }, select: { id: true, number: true, departmentId: true, analysis: true } }),
      this.prisma.department.findMany({ where: { workspaceId }, select: { id: true, key: true } }),
      this.prisma.ticketEvent.findMany({
        where: { ticketId: { in: ticketIds }, type: 'department_changed', actorType: 'user', createdAt: { gte: from } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.actionProposal.findMany({ where: { ticketId: { in: ticketIds }, createdAt: { gte: from } }, orderBy: { createdAt: 'desc' } }),
      this.prisma.message.findMany({
        where: { ticketId: { in: ticketIds }, authorType: 'operator', visibility: 'public', createdAt: { gte: from } },
        select: { ticketId: true, bodyText: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.agentQuestion.findMany({ where: { ticketId: { in: ticketIds }, createdAt: { gte: from } }, orderBy: { createdAt: 'desc' } }),
    ]);
    const drafts = await this.prisma.replyDraft.findMany({
      where: { ticketId: { in: ticketIds }, source: 'agent' },
      select: { ticketId: true, bodyHtml: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });

    const departmentKey = new Map(departments.map((d) => [d.id, d.key]));
    const keyOf = (id: unknown) => (typeof id === 'string' ? (departmentKey.get(id) ?? id) : null);
    const ticketById = new Map(tickets.map((t) => [t.id, t]));
    const ref = (ticketId: string): TicketRef => ({ id: ticketId, number: ticketById.get(ticketId)?.number ?? 0 });
    const analysisOf = (ticketId: string) => (ticketById.get(ticketId)?.analysis ?? null) as TicketAnalysis | null;

    const byDepartment: Record<string, Tally> = {};
    const byPlaybook: Record<string, Tally> = {};
    const tally = (ticketId: string, signal: keyof Tally) => {
      const ticket = ticketById.get(ticketId);
      const department = keyOf(ticket?.departmentId) ?? 'none';
      (byDepartment[department] ??= emptyTally())[signal] += 1;
      for (const playbook of analysisOf(ticketId)?.playbooksUsed ?? []) {
        (byPlaybook[playbook] ??= emptyTally())[signal] += 1;
      }
    };
    for (const ticket of tickets) tally(ticket.id, 'tickets');

    const departmentOverrides = overrides.map((event) => {
      tally(event.ticketId, 'departmentOverrides');
      const data = event.data as { from?: string | null; to?: string | null };
      return { ...ref(event.ticketId), agentChose: analysisOf(event.ticketId)?.department ?? null, from: keyOf(data.from), to: keyOf(data.to) };
    });

    const byAction: Record<string, Record<string, number>> = {};
    for (const proposal of proposals) {
      const counts = (byAction[proposal.action] ??= {});
      counts[proposal.status] = (counts[proposal.status] ?? 0) + 1;
      if (proposal.status === 'rejected') tally(proposal.ticketId, 'rejectedActions');
    }
    const rejected = proposals
      .filter((p) => p.status === 'rejected')
      .slice(0, MAX_EXAMPLES)
      .map((p) => ({ ...ref(p.ticketId), action: p.action, params: p.normalizedParams ?? p.params, reason: p.reason, comment: p.decisionComment }));

    const replyStats = { sent: replies.length, withoutAgentDraft: 0, unchanged: 0, edited: 0, rewritten: 0 };
    const rewrittenExamples: Array<TicketRef & { similarity: number }> = [];
    for (const reply of replies) {
      const draft = drafts.find((d) => d.ticketId === reply.ticketId && d.createdAt <= reply.createdAt);
      if (!draft) {
        replyStats.withoutAgentDraft += 1;
        continue;
      }
      const similarity = textSimilarity(htmlToPlainText(draft.bodyHtml), reply.bodyText);
      if (similarity >= UNCHANGED) replyStats.unchanged += 1;
      else if (similarity >= REWRITTEN) replyStats.edited += 1;
      else {
        replyStats.rewritten += 1;
        tally(reply.ticketId, 'rewrittenReplies');
        if (rewrittenExamples.length < MAX_EXAMPLES) rewrittenExamples.push({ ...ref(reply.ticketId), similarity: round(similarity) });
      }
    }

    const finished = runs.filter((r) => r.startedAt && r.finishedAt);
    const analyses = tickets.map((t) => t.analysis as TicketAnalysis | null).filter((a) => a !== null);
    return {
      period: { from: from.toISOString(), to: to.toISOString(), days: options.days },
      runs: {
        total: runs.length,
        byStatus: countBy(runs, (r) => r.status),
        byConfigVersion: countBy(runs, (r) => String(r.configVersion?.number ?? 'none')),
        tokensIn: sum(runs.map((r) => r.tokensIn)),
        tokensOut: sum(runs.map((r) => r.tokensOut)),
        cost: round(sum(runs.map((r) => r.cost ?? 0)), 4),
        currency: workspace.currency,
        avgDurationMs: finished.length
          ? Math.round(sum(finished.map((r) => r.finishedAt!.getTime() - r.startedAt!.getTime())) / finished.length)
          : null,
        failures: runs
          .filter((r) => r.status === 'failed')
          .slice(0, MAX_EXAMPLES)
          .map((r) => ({ ...ref(r.ticketId), runId: r.id, error: (r.error ?? '').slice(0, 300) })),
      },
      tickets: {
        analyzed: analyses.length,
        needsHuman: analyses.filter((a) => a.needsHuman).length,
        sentToTriage: analyses.filter((a) => a.sentToTriage).length,
      },
      departmentOverrides: departmentOverrides.slice(0, MAX_EXAMPLES),
      actions: { byAction, rejected },
      replies: { ...replyStats, rewrittenExamples },
      questions: { asked: questions.length, examples: questions.slice(0, MAX_EXAMPLES).map((q) => ({ ...ref(q.ticketId), text: q.text })) },
      byDepartment,
      byPlaybook,
    };
  }
}

/** Word-level similarity: 2·LCS / (|a| + |b|). 1 — the same text, 0 — nothing in common. */
export function textSimilarity(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (left.length === 0 && right.length === 0) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  let previous = new Array<number>(right.length + 1).fill(0);
  for (const word of left) {
    const current = new Array<number>(right.length + 1).fill(0);
    for (let j = 1; j <= right.length; j++) {
      current[j] = word === right[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!);
    }
    previous = current;
  }
  return (2 * previous[right.length]!) / (left.length + right.length);
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, MAX_WORDS);
}

function emptyTally(): Tally {
  return { tickets: 0, departmentOverrides: 0, rejectedActions: 0, rewrittenReplies: 0 };
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
