export const MAIL_QUEUE = 'mail';
export const POLL_JOB = 'poll';

export function pollSchedulerId(channelId: string): string {
  return `poll:${channelId}`;
}
