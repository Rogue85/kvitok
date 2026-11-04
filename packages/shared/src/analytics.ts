import { z } from 'zod';
import type { AgentRunStatus } from './agent.js';
import type { TicketStatus } from './tickets.js';

export const ANALYTICS_PERIODS = [7, 30, 90] as const;

export const AnalyticsQuerySchema = z.object({
  /** The last N days, today included. */
  days: z.coerce.number().int().min(1).max(366).default(30),
  /** IANA time zone the days are counted in; an unknown one falls back to UTC. */
  tz: z.string().trim().max(64).optional(),
});
export type AnalyticsQuery = z.infer<typeof AnalyticsQuerySchema>;

/** What agent runs spent; the cost is in the workspace currency. */
export interface AgentUsageDto {
  runs: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  /** Runs that used tokens on a model without a price: their tokens are counted, their cost is not. */
  unpricedRuns: number;
}

export interface TicketCostDto {
  /** The workspace currency. */
  currency: string;
  /** Runs that worked on the ticket. */
  usage: AgentUsageDto;
  /** Trial runs and replays on this ticket: tuning the agent, not handling the ticket. */
  dryRuns: AgentUsageDto;
}

/** One slice of agent spending. */
export interface AnalyticsCostRowDto {
  /** A department id, a model or a trigger type; null — none. */
  key: string | null;
  runs: number;
  tickets: number;
  tokens: number;
  cost: number;
  /** Runs that used tokens on a model without a price. */
  unpricedRuns: number;
}

export interface AnalyticsDayDto {
  /** YYYY-MM-DD in the report's time zone. */
  date: string;
  cost: number;
  runs: number;
  tokens: number;
  ticketsCreated: number;
  ticketsResolved: number;
}

export interface AnalyticsDto {
  period: { from: string; to: string; days: number; timeZone: string };
  /** The workspace currency: every cost in the report is in it. */
  currency: string;
  days: AnalyticsDayDto[];
  agent: {
    usage: AgentUsageDto;
    /** Trial runs and replays: the cost of tuning the agent. */
    dryRuns: AgentUsageDto;
    ticketsWithRuns: number;
    /** The average cost of a ticket the agent worked on in the period. */
    costPerTicket: number | null;
    byStatus: Partial<Record<AgentRunStatus, number>>;
    avgDurationMs: number | null;
    byDepartment: AnalyticsCostRowDto[];
    byModel: AnalyticsCostRowDto[];
    byTrigger: AnalyticsCostRowDto[];
    /** Tickets that cost the most in the period. */
    topTickets: Array<{ id: string; number: number; subject: string; runs: number; cost: number }>;
  };
  tickets: {
    created: number;
    resolved: number;
    /** Open now, whenever created. */
    open: number;
    /** The current status of the tickets created in the period. */
    byStatus: Partial<Record<TicketStatus, number>>;
    byChannel: Array<{ key: string | null; count: number }>;
    firstResponseMedianMs: number | null;
    resolutionMedianMs: number | null;
  };
  /** How operators used the agent's work on the tickets it analyzed in the period. */
  quality: {
    analyzed: number;
    needsHuman: number;
    sentToTriage: number;
    departmentOverrides: number;
    questions: number;
    replies: { sent: number; withoutAgentDraft: number; unchanged: number; edited: number; rewritten: number };
    /** The agent's proposals by status. */
    actions: Record<string, number>;
    /** Actions operators executed by hand: in all, instead of an agent proposal, and ones the agent missed. */
    manualActions: { executed: number; replaced: number; missed: number };
  };
}
