import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { AGENT_WAIT_MS, incomingJobId, NOTIFY_JOB, NOTIFY_QUEUE, type NotifyJobData } from './notifications.constants';

const JOB_OPTIONS: JobsOptions = { attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: true, removeOnFail: 100 };

/**
 * Queues notifications after a change is committed; the worker decides who gets them.
 * A failure here is logged and never breaks the change that caused it.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectQueue(NOTIFY_QUEUE) private readonly queue: Queue<NotifyJobData>,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * A new ticket or customer message. When the agent was triggered the notification waits for its analysis
   * (department, summary), at most `AGENT_WAIT_MS`; messages during the wait join the same notification.
   */
  async incoming(workspaceId: string, ticketId: string, options: { messageId: string; created: boolean; waitForAgent: boolean }): Promise<void> {
    await this.safely(async () => {
      // A message keeps the time it was sent, so the wait counts from it, not from now.
      const message = await this.prisma.message.findUnique({ where: { id: options.messageId }, select: { createdAt: true } });
      const since = (message?.createdAt ?? new Date()).toISOString();
      const data: NotifyJobData = { kind: 'incoming', workspaceId, ticketId, created: options.created, since };
      // removeOnFail: a failed job with this id would swallow the next messages of the ticket.
      await this.queue.add(NOTIFY_JOB, data, {
        ...JOB_OPTIONS,
        jobId: incomingJobId(ticketId),
        delay: options.waitForAgent ? AGENT_WAIT_MS : 0,
        removeOnFail: true,
      });
    });
  }

  /**
   * The agent finished with the ticket and has nothing queued: a waiting `incoming` notification goes out now.
   * Questions and proposals of this run join it or go out on their own.
   */
  async agentSettled(workspaceId: string, ticketId: string, runStartedAt: Date): Promise<void> {
    await this.safely(async () => {
      const [questions, proposals] = await Promise.all([
        this.prisma.agentQuestion.count({ where: { ticketId, status: 'open', createdAt: { gte: runStartedAt } } }),
        this.prisma.actionProposal.count({ where: { ticketId, status: 'proposed', createdAt: { gte: runStartedAt } } }),
      ]);
      const needsOperator = questions + proposals > 0;
      const waiting = await this.queue.getJob(incomingJobId(ticketId));
      if (waiting !== undefined && (await waiting.isDelayed())) {
        if (needsOperator) await waiting.updateData({ ...waiting.data, needsOperator: true });
        await waiting.promote();
        return;
      }
      if (needsOperator) {
        await this.queue.add(NOTIFY_JOB, { kind: 'agent_needs_operator', workspaceId, ticketId, since: runStartedAt.toISOString() }, JOB_OPTIONS);
      }
    });
  }

  async assigned(workspaceId: string, ticketId: string, actorId: string): Promise<void> {
    await this.safely(() => this.queue.add(NOTIFY_JOB, { kind: 'assigned', workspaceId, ticketId, actorId }, JOB_OPTIONS));
  }

  async deliveryFailed(workspaceId: string, ticketId: string, messageId: string | null): Promise<void> {
    await this.safely(() => this.queue.add(NOTIFY_JOB, { kind: 'delivery_failed', workspaceId, ticketId, messageId }, JOB_OPTIONS));
  }

  async agentFailed(workspaceId: string, ticketId: string): Promise<void> {
    await this.safely(() => this.queue.add(NOTIFY_JOB, { kind: 'agent_failed', workspaceId, ticketId }, JOB_OPTIONS));
  }

  private async safely(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.logger.warn(`Notification not queued: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
