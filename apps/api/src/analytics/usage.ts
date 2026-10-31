import type { AgentUsageDto } from '@kvitok/shared';

export interface RunUsage {
  tokensIn: number;
  tokensOut: number;
  /** In the workspace currency; null — the model had no price. */
  cost: number | null;
}

/** Sums runs: tokens over all of them, the cost over the priced ones. */
export function summarizeUsage(runs: RunUsage[]): AgentUsageDto {
  return {
    runs: runs.length,
    tokensIn: runs.reduce((sum, r) => sum + r.tokensIn, 0),
    tokensOut: runs.reduce((sum, r) => sum + r.tokensOut, 0),
    cost: roundMoney(runs.reduce((sum, r) => sum + (r.cost ?? 0), 0)),
    unpricedRuns: runs.filter((r) => isUnpriced(r)).length,
  };
}

/** Used tokens on a model without a price; a run that failed before calling the model spent nothing. */
export function isUnpriced(run: RunUsage): boolean {
  return run.cost === null && run.tokensIn + run.tokensOut > 0;
}

/** Run costs are stored to a millionth; sums keep that precision without float noise. */
export function roundMoney(amount: number): number {
  return Math.round(amount * 1_000_000) / 1_000_000;
}
