import { Controller, Param, Sse, UseGuards, type MessageEvent } from '@nestjs/common';
import { interval, map, merge, takeUntil, type Observable } from 'rxjs';
import { WorkspaceGuard } from '../workspaces/workspace.guard';
import { RealtimeService } from './realtime.service';

const HEARTBEAT_MS = 25_000;

@Controller('workspaces/:workspaceId/events')
@UseGuards(WorkspaceGuard)
export class RealtimeController {
  constructor(private readonly realtime: RealtimeService) {}

  @Sse()
  stream(@Param('workspaceId') workspaceId: string): Observable<MessageEvent> {
    return merge(
      this.realtime.stream(workspaceId).pipe(map((event) => ({ type: event.type, data: event }))),
      // Keep proxies from closing an idle connection.
      interval(HEARTBEAT_MS).pipe(map(() => ({ type: 'ping', data: {} }))),
    ).pipe(takeUntil(this.realtime.closed$));
  }
}
