import { Injectable } from '@nestjs/common';
import type { AnalyticsCostRowDto, AnalyticsDayDto, AnalyticsDto, AnalyticsQuery } from '@kvitok/shared';
import { PrismaService } from '../prisma/prisma.service';
import { QualityReportService } from './quality-report.service';
import { isUnpriced, roundMoney, summarizeUsage } from './usage';
import { resolveTimeZone, ZonedDays } from './zoned-days';

const TOP_TICKETS = 10;
const OPEN_STATUSES = ['new', 'open', 'pending'] as const;

interface RunRow {
  ticketId: string;
  trigger: unknown;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  cost: number | null;
  departmentId: string | null;
}

/** What support cost and how it went over a period: agent spending, ticket flow, how operators used the agent's work. */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quality: QualityReportService,
  ) {}

  async report(workspaceId: string, query: AnalyticsQuery): Promise<AnalyticsDto> {
    const zone = new ZonedDays(resolveTimeZone(query.tz));
    const to = new Date();
    const dayKeys = zone.lastDays(query.days, to);
    const from = zone.startOf(dayKeys[0]!);

    const [workspace, allRuns, created, resolved, open, quality] = await Promise.all([
      this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { currency: true } }),
      this.prisma.agentRun.findMany({
        where: { workspaceId, createdAt: { gte: from } },
        select: {
          ticketId: true,
          dryRun: true,
          status: true,
          trigger: true,
          model: true,
          tokensIn: true,
          tokensOut: true,
          cost: true,
          startedAt: true,
          finishedAt: true,
          createdAt: true,
          ticket: { select: { departmentId: true } },
        },
      }),
      this.prisma.ticket.findMany({
        where: { workspaceId, createdAt: { gte: from } },
        select: { status: true, channelId: true, createdAt: true, firstResponseAt: true },
      }),
      this.prisma.ticket.findMany({ where: { workspaceId, resolvedAt: { gte: from } }, select: { createdAt: true, resolvedAt: true } }),
      this.prisma.ticket.count({ where: { workspaceId, status: { in: [...OPEN_STATUSES] } } }),
      this.quality.report(workspaceId, { days: query.days, from }),
    ]);

    const runs = allRuns.filter((r) => !r.dryRun);
    const usage = summarizeUsage(runs);
    const dryRuns = summarizeUsage(allRuns.filter((r) => r.dryRun));

    const days = new Map<string, AnalyticsDayDto>(
      dayKeys.map((date) => [date, { date, cost: 0, runs: 0, tokens: 0, ticketsCreated: 0, ticketsResolved: 0 }]),
    );
    for (const run of runs) {
      const day = days.get(zone.key(run.createdAt));
      if (!day) continue;
      day.cost += run.cost ?? 0;
      day.runs += 1;
      day.tokens += run.tokensIn + run.tokensOut;
    }
    for (const ticket of created) {
      const day = days.get(zone.key(ticket.createdAt));
      if (day) day.ticketsCreated += 1;
    }
    for (const ticket of resolved) {
      const day = days.get(zone.key(ticket.resolvedAt!));
      if (day) day.ticketsResolved += 1;
    }

    const rows: RunRow[] = runs.map((r) => ({ ...r, departmentId: r.ticket.departmentId }));
    const ticketCosts = breakdown(rows, (r) => r.ticketId);
    const ticketsWithRuns = ticketCosts.length;
    const top = ticketCosts.filter((row) => row.cost > 0).slice(0, TOP_TICKETS);
    const topInfo = await this.prisma.ticket.findMany({
      where: { id: { in: top.map((row) => row.key!) } },
      select: { id: true, number: true, subject: true },
    });
    const finished = runs.filter((r) => r.startedAt && r.finishedAt);

    const actions: Record<string, number> = {};
    for (const statuses of Object.values(quality.actions.byAction)) {
      for (const [status, count] of Object.entries(statuses)) actions[status] = (actions[status] ?? 0) + count;
    }

    return {
      period: { from: from.toISOString(), to: to.toISOString(), days: query.days, timeZone: zone.timeZone },
      currency: workspace.currency,
      days: [...days.values()].map((day) => ({ ...day, cost: roundMoney(day.cost) })),
      agent: {
        usage,
        dryRuns,
        ticketsWithRuns,
        costPerTicket: ticketsWithRuns > 0 ? roundMoney(usage.cost / ticketsWithRuns) : null,
        byStatus: countBy(runs, (r) => r.status),
        avgDurationMs: finished.length
          ? Math.round(finished.reduce((sum, r) => sum + r.finishedAt!.getTime() - r.startedAt!.getTime(), 0) / finished.length)
          : null,
        byDepartment: breakdown(rows, (r) => r.departmentId),
        byModel: breakdown(rows, (r) => r.model),
        byTrigger: breakdown(rows, (r) => (r.trigger as { type?: string } | null)?.type ?? null),
        topTickets: top.flatMap((row) => {
          const ticket = topInfo.find((t) => t.id === row.key);
          return ticket ? [{ id: ticket.id, number: ticket.number, subject: ticket.subject, runs: row.runs, cost: row.cost }] : [];
        }),
      },
      tickets: {
        created: created.length,
        resolved: resolved.length,
        open,
        byStatus: countBy(created, (t) => t.status),
        byChannel: Object.entries(countBy(created, (t) => t.channelId ?? ''))
          .map(([key, count]) => ({ key: key || null, count: count ?? 0 }))
          .sort((a, b) => b.count - a.count),
        firstResponseMedianMs: median(created.flatMap((t) => (t.firstResponseAt ? [t.firstResponseAt.getTime() - t.createdAt.getTime()] : []))),
        resolutionMedianMs: median(resolved.map((t) => t.resolvedAt!.getTime() - t.createdAt.getTime())),
      },
      quality: {
        analyzed: quality.tickets.analyzed,
        needsHuman: quality.tickets.needsHuman,
        sentToTriage: quality.tickets.sentToTriage,
        // Every override is tallied under exactly one department; the list itself is only examples.
        departmentOverrides: Object.values(quality.byDepartment).reduce((sum, tally) => sum + tally.departmentOverrides, 0),
        questions: quality.questions.asked,
        replies: {
          sent: quality.replies.sent,
          withoutAgentDraft: quality.replies.withoutAgentDraft,
          unchanged: quality.replies.unchanged,
          edited: quality.replies.edited,
          rewritten: quality.replies.rewritten,
        },
        actions,
      },
    };
  }
}

/** Runs grouped by a key, the most expensive group first. */
function breakdown(runs: RunRow[], keyOf: (run: RunRow) => string | null): AnalyticsCostRowDto[] {
  const groups = new Map<string | null, { runs: number; tickets: Set<string>; tokens: number; cost: number; unpricedRuns: number }>();
  for (const run of runs) {
    const key = keyOf(run);
    let group = groups.get(key);
    if (!group) {
      group = { runs: 0, tickets: new Set(), tokens: 0, cost: 0, unpricedRuns: 0 };
      groups.set(key, group);
    }
    group.runs += 1;
    group.tickets.add(run.ticketId);
    group.tokens += run.tokensIn + run.tokensOut;
    group.cost += run.cost ?? 0;
    if (isUnpriced(run)) group.unpricedRuns += 1;
  }
  return [...groups]
    .map(([key, g]) => ({ key, runs: g.runs, tickets: g.tickets.size, tokens: g.tokens, cost: roundMoney(g.cost), unpricedRuns: g.unpricedRuns }))
    .sort((a, b) => b.cost - a.cost || b.runs - a.runs);
}

function countBy<T, K extends string>(items: T[], key: (item: T) => K): Partial<Record<K, number>> {
  const counts: Partial<Record<K, number>> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}
