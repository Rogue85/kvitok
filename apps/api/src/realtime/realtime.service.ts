import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { RealtimeEvent } from '@kvitok/shared';
import type IORedis from 'ioredis';
import { filter, Observable, Subject } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS } from '../redis/redis.module';

const PREFIX = 'rt:';

/**
 * An event with the department and the assignees of its ticket when the event fans out, for filtering by what a
 * connection may see. `departmentId` undefined — not a ticket event, or the ticket is gone.
 */
export interface RoutedEvent {
  event: RealtimeEvent;
  departmentId: string | null | undefined;
  assigneeIds: string[];
}

/**
 * Events for the live UI. Both the API and the worker publish them (via Redis pub/sub),
 * the SSE endpoint keeps one subscription per process and fans events out by workspace.
 */
@Injectable()
export class RealtimeService implements OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name);
  private readonly events = new Subject<{ workspaceId: string } & RoutedEvent>();
  private subscriber: IORedis | null = null;
  /** Department lookups run one after another, so events keep their order. */
  private routing: Promise<void> = Promise.resolve();
  /** Fires on shutdown: SSE streams end and the process can exit. */
  readonly closed$ = new Subject<void>();

  constructor(
    @Inject(REDIS) private readonly redis: IORedis,
    private readonly prisma: PrismaService,
  ) {}

  async publish(workspaceId: string, event: RealtimeEvent): Promise<void> {
    try {
      await this.redis.publish(`${PREFIX}${workspaceId}`, JSON.stringify(event));
    } catch (error) {
      // The UI refreshes on the next request; a write must not be lost because of this.
      this.logger.warn(`Realtime publish failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  stream(workspaceId: string): Observable<RoutedEvent> {
    this.ensureSubscribed();
    return this.events.pipe(filter((item) => item.workspaceId === workspaceId));
  }

  async onModuleDestroy(): Promise<void> {
    this.closed$.next();
    this.closed$.complete();
    this.events.complete();
    if (this.subscriber !== null) {
      await this.subscriber.quit();
      this.subscriber = null;
    }
  }

  /** For tests: wait until the Redis subscription is active. */
  async ready(): Promise<void> {
    this.ensureSubscribed();
    await this.subscriber!.psubscribe(`${PREFIX}*`);
  }

  private ensureSubscribed(): void {
    if (this.subscriber !== null) {
      return;
    }
    const subscriber = this.redis.duplicate();
    this.subscriber = subscriber;
    void subscriber.psubscribe(`${PREFIX}*`);
    subscriber.on('pmessage', (_pattern: string, channel: string, message: string) => {
      let event: RealtimeEvent;
      try {
        event = JSON.parse(message) as RealtimeEvent;
      } catch {
        this.logger.warn(`Bad realtime message on ${channel}`);
        return;
      }
      const workspaceId = channel.slice(PREFIX.length);
      this.routing = this.routing.then(async () => {
        this.events.next({ workspaceId, event, ...(await this.ticketOf(event)) });
      });
    });
  }

  /**
   * The ticket's current department and assignees; the department is undefined when there is none to look up or the lookup
   * failed. A move carries its departments itself.
   */
  private async ticketOf(event: RealtimeEvent): Promise<Omit<RoutedEvent, 'event'>> {
    if (!('ticketId' in event) || event.type === 'ticket.access') {
      return { departmentId: undefined, assigneeIds: [] };
    }
    try {
      const ticket = await this.prisma.ticket.findUnique({
        where: { id: event.ticketId },
        select: { departmentId: true, assignees: { select: { userId: true } } },
      });
      if (ticket === null) return { departmentId: undefined, assigneeIds: [] };
      return {
        departmentId: event.type === 'ticket.moved' ? undefined : ticket.departmentId,
        assigneeIds: ticket.assignees.map((a) => a.userId),
      };
    } catch (error) {
      this.logger.warn(`Realtime ticket lookup failed: ${error instanceof Error ? error.message : String(error)}`);
      return { departmentId: undefined, assigneeIds: [] };
    }
  }
}
