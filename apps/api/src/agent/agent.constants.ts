export const AGENT_QUEUE = 'agent';
export const RUN_JOB = 'run';

export function cancelKey(ticketId: string): string {
  return `agent:cancel:${ticketId}`;
}

export interface RunJobData {
  ticketId: string;
}
