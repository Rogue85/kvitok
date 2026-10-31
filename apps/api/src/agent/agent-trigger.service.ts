import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import { newId } from '../common/ids';
import { json } from '../common/json';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { REDIS } from '../redis/redis.module';
import { AGENT_QUEUE, cancelKey, RUN_JOB, type RunJobData } from './agent.constants';
import { AUTOMATIC_TRIGGERS, type AgentPending, type AgentTrigger } from './agent-trigger.types';

const CANCEL_TTL_MS = 10 * 60 * 1000;

export interface TriggerOptions {
  mode: 'triage' | 'refine';
  /** `debounce` — the pause from the agent settings (two emails in a row → one run). */
  delay?: number | 'debounce';
}

type LockedRow = { workspace_id: string; agent_state: string; agent_job_id: string | null; agent_pending: AgentPending | null };

/**
 * Queues an agent run: one run per ticket at any moment.
 * While the agent works, triggers accumulate in agent_pending, the current run is cancelled and a new one starts after it.
 */
@Injectable()
export class AgentTriggerService {
  constructor(
    @InjectQueue(AGENT_QUEUE) private readonly queue: Queue,
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: IORedis,
    private readonly realtime: RealtimeService,
  ) {}

  async trigger(ticketId: string, trigger: AgentTrigger, options: TriggerOptions): Promise<boolean> {
    const ticket = await this.prisma.ticket.findUnique({ where: { id: ticketId }, select: { workspaceId: true, agentSkipped: true } });
    if (ticket === null) return false;
    const settings = await this.prisma.agentSettings.findUnique({ where: { workspaceId: ticket.workspaceId } });
    if (!settings?.enabled) return false;
    if (ticket.agentSkipped && AUTOMATIC_TRIGGERS.includes(trigger.type)) return false;

    const delay = options.delay === 'debounce' ? settings.debounceSeconds * 1000 : (options.delay ?? 0);
    const action = await this.prisma.$transaction(async (tx) => {
      const row = await lockTicket(tx, ticketId);
      const pending = mergePending(row.agent_pending, options.mode, trigger);

      if (row.agent_state === 'running') {
        await tx.ticket.update({ where: { id: ticketId }, data: { agentPending: json(pending), agentRerunPending: true } });
        return { kind: 'cancel-running' as const };
      }
      if (row.agent_state === 'queued' && row.agent_job_id) {
        await tx.ticket.update({ where: { id: ticketId }, data: { agentPending: json(pending) } });
        return { kind: 'reschedule' as const, jobId: row.agent_job_id };
      }
      const jobId = `${RUN_JOB}:${ticketId}:${newId()}`;
      await tx.ticket.update({
        where: { id: ticketId },
        data: { agentPending: json(pending), agentState: 'queued', agentJobId: jobId },
      });
      return { kind: 'add' as const, jobId };
    });

    if (action.kind === 'cancel-running') {
      await this.redis.set(cancelKey(ticketId), '1', 'PX', CANCEL_TTL_MS);
    } else if (action.kind === 'reschedule') {
      const job = await this.queue.getJob(action.jobId);
      if (job === undefined) {
        await this.addRunJob(ticketId, action.jobId, delay);
      } else if (await job.isDelayed()) {
        // Debounce extends the wait, an operator note starts right away.
        if (delay === 0) await job.promote();
        else await job.changeDelay(delay);
      }
    } else {
      await this.addRunJob(ticketId, action.jobId, delay);
    }

    await this.realtime.publish(ticket.workspaceId, { type: 'agent.updated', ticketId, state: action.kind === 'cancel-running' ? 'running' : 'queued' });
    return true;
  }

  async addRunJob(ticketId: string, jobId: string, delay = 0): Promise<void> {
    await this.queue.add(RUN_JOB, { ticketId } satisfies RunJobData, { jobId, delay, removeOnComplete: true, removeOnFail: 100 });
  }
}

export async function lockTicket(tx: Prisma.TransactionClient, ticketId: string): Promise<LockedRow & { revision: number; agent_rerun_pending: boolean }> {
  const rows = await tx.$queryRaw<Array<LockedRow & { revision: number; agent_rerun_pending: boolean }>>`
    SELECT workspace_id, agent_state::text AS agent_state, agent_job_id, agent_pending, revision, agent_rerun_pending
    FROM tickets WHERE id = ${ticketId} FOR UPDATE`;
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Ticket ${ticketId} not found`);
  }
  return row;
}

/** refine wins over triage: if an operator clarified something, the run is a refinement. */
export function mergePending(existing: AgentPending | null, mode: 'triage' | 'refine', trigger: AgentTrigger): AgentPending {
  return {
    mode: existing?.mode === 'refine' || mode === 'refine' ? 'refine' : 'triage',
    triggers: [...(existing?.triggers ?? []), trigger].slice(-20),
  };
}
