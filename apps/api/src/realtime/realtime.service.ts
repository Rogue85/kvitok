import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { RealtimeEvent } from '@kvitok/shared';
import type IORedis from 'ioredis';
import { filter, map, Observable, Subject } from 'rxjs';
import { REDIS } from '../redis/redis.module';

const PREFIX = 'rt:';

/**
 * Events for the live UI. Both the API and the worker publish them (via Redis pub/sub),
 * the SSE endpoint keeps one subscription per process and fans events out by workspace.
 */
@Injectable()
export class RealtimeService implements OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name);
  private readonly events = new Subject<{ workspaceId: string; event: RealtimeEvent }>();
  private subscriber: IORedis | null = null;
  /** Fires on shutdown: SSE streams end and the process can exit. */
  readonly closed$ = new Subject<void>();

  constructor(@Inject(REDIS) private readonly redis: IORedis) {}

  async publish(workspaceId: string, event: RealtimeEvent): Promise<void> {
    try {
      await this.redis.publish(`${PREFIX}${workspaceId}`, JSON.stringify(event));
    } catch (error) {
      // The UI refreshes on the next request; a write must not be lost because of this.
      this.logger.warn(`Realtime publish failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  stream(workspaceId: string): Observable<RealtimeEvent> {
    this.ensureSubscribed();
    return this.events.pipe(
      filter((item) => item.workspaceId === workspaceId),
      map((item) => item.event),
    );
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
      try {
        this.events.next({ workspaceId: channel.slice(PREFIX.length), event: JSON.parse(message) as RealtimeEvent });
      } catch {
        this.logger.warn(`Bad realtime message on ${channel}`);
      }
    });
  }
}
