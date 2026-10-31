export const ACTIONS_QUEUE = 'actions';
export const EXECUTE_JOB = 'execute';
/** Attempts to learn the execution outcome: timeout, network, 5xx — retrying with the same key is safe. */
export const EXECUTE_ATTEMPTS = 6;

export interface ExecuteJobData {
  proposalId: string;
}
