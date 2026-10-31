import { z } from 'zod';

/* Actions in external systems: the agent proposes (validate), an operator decides, the worker executes (execute). */

export const ACTION_STATUSES = ['proposed', 'approved', 'executing', 'executed', 'failed', 'rejected', 'superseded'] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export interface ActionProposalDto {
  id: string;
  /** The agent run that proposed the action. */
  runId: string | null;
  integrationId: string;
  integrationName: string;
  action: string;
  title: string;
  params: Record<string, unknown>;
  /** Parameters after the backend validated them — these are what gets executed. */
  normalizedParams: Record<string, unknown> | null;
  /** What will happen: "Credit 19 points (tier cashback…) — Anna". */
  preview: string | null;
  warnings: string[];
  reason: string;
  calculation: string | null;
  status: ActionStatus;
  decidedBy: { id: string; name: string } | null;
  decidedAt: string | null;
  decisionComment: string | null;
  executedAt: string | null;
  result: unknown;
  externalRef: string | null;
  error: string | null;
  attempts: number;
  createdAt: string;
}

export const ApproveActionSchema = z.object({
  comment: z.string().trim().max(2000).optional(),
});
export type ApproveActionInput = z.infer<typeof ApproveActionSchema>;

/** The rejection reason is visible to the agent: it will not propose the same thing again. */
export const RejectActionSchema = z.object({
  comment: z.string().trim().max(2000).optional(),
});
export type RejectActionInput = z.infer<typeof RejectActionSchema>;
