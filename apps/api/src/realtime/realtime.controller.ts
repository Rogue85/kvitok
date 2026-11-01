import { Controller, HttpException, Param, Sse, UseGuards, type MessageEvent } from '@nestjs/common';
import { exhaustMap, filter, interval, map, merge, takeUntil, type Observable } from 'rxjs';
import { CurrentAuth } from '../auth/decorators';
import { revalidateAuth } from '../auth/revalidate';
import type { AuthContext } from '../common/request';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceGuard, workspaceRole } from '../workspaces/workspace.guard';
import { RealtimeService } from './realtime.service';

const HEARTBEAT_MS = 25_000;

@Controller('workspaces/:workspaceId/events')
@UseGuards(WorkspaceGuard)
export class RealtimeController {
  constructor(
    private readonly realtime: RealtimeService,
    private readonly prisma: PrismaService,
  ) {}

  @Sse()
  stream(@CurrentAuth() auth: AuthContext, @Param('workspaceId') workspaceId: string): Observable<MessageEvent> {
    // Access is checked again on every heartbeat: an ended session, a disabled user or a removed membership closes the stream.
    const accessLost$ = interval(HEARTBEAT_MS).pipe(
      exhaustMap(() => this.hasAccess(auth, workspaceId)),
      filter((allowed) => !allowed),
    );
    return merge(
      this.realtime.stream(workspaceId).pipe(map((event) => ({ type: event.type, data: event }))),
      // Keep proxies from closing an idle connection.
      interval(HEARTBEAT_MS).pipe(map(() => ({ type: 'ping', data: {} }))),
    ).pipe(takeUntil(merge(this.realtime.closed$, accessLost$)));
  }

  /** Whether the connection may still receive the workspace events. A check that failed for another reason keeps it: the next one decides. */
  async hasAccess(auth: AuthContext, workspaceId: string): Promise<boolean> {
    try {
      const current = await revalidateAuth(this.prisma, auth);
      if (current === null) return false;
      await workspaceRole(this.prisma, current, workspaceId);
      return true;
    } catch (error) {
      return !(error instanceof HttpException);
    }
  }
}
