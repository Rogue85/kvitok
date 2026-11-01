import { Controller, HttpException, Sse, UseGuards, type MessageEvent } from '@nestjs/common';
import { canSeeDepartment, type DepartmentScope } from '@kvitok/shared';
import { filter, ignoreElements, interval, map, merge, share, switchMap, takeUntil, tap, type Observable } from 'rxjs';
import { CurrentAuth } from '../auth/decorators';
import { revalidateAuth } from '../auth/revalidate';
import type { AuthContext, WorkspaceContext } from '../common/request';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentWorkspace, WorkspaceGuard, workspaceAccess } from '../workspaces/workspace.guard';
import { RealtimeService, type RoutedEvent } from './realtime.service';

const HEARTBEAT_MS = 25_000;

@Controller('workspaces/:workspaceId/events')
@UseGuards(WorkspaceGuard)
export class RealtimeController {
  constructor(
    private readonly realtime: RealtimeService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Events of tickets the user may see. Access is checked again on every heartbeat and when the user's access changes:
   * an ended session, a disabled user or a removed membership closes the stream, changed departments change what it carries.
   */
  @Sse()
  stream(@CurrentAuth() auth: AuthContext, @CurrentWorkspace() workspace: WorkspaceContext): Observable<MessageEvent> {
    const { workspaceId } = workspace;
    let scope = workspace.scope;
    const events$ = this.realtime.stream(workspaceId);
    const accessChanged$ = events$.pipe(filter(({ event }) => event.type === 'access.changed' && event.userId === auth.user.id));
    // The latest check wins: one that started before the access changed may have read the old departments.
    const checks$ = merge(interval(HEARTBEAT_MS), accessChanged$).pipe(
      switchMap(() => this.currentScope(auth, workspaceId)),
      share(),
    );
    const accessLost$ = checks$.pipe(filter((current) => current === null));
    return merge(
      checks$.pipe(
        tap((current) => {
          if (current) scope = current;
        }),
        ignoreElements(),
      ),
      events$.pipe(
        filter((item) => deliverable(item, scope, auth.user.id)),
        map(({ event }) => ({ type: event.type, data: event })),
      ),
      // Keep proxies from closing an idle connection.
      interval(HEARTBEAT_MS).pipe(map(() => ({ type: 'ping', data: {} }))),
    ).pipe(takeUntil(merge(this.realtime.closed$, accessLost$)));
  }

  /**
   * The departments the connection may still see; null when it may no longer receive the workspace events.
   * A check that failed for another reason keeps the connection as it is: the next one decides.
   */
  async currentScope(auth: AuthContext, workspaceId: string): Promise<DepartmentScope | null | undefined> {
    try {
      const current = await revalidateAuth(this.prisma, auth);
      if (current === null) return null;
      return (await workspaceAccess(this.prisma, current, workspaceId)).scope;
    } catch (error) {
      return error instanceof HttpException ? null : undefined;
    }
  }
}

/** Whether a connection with this scope gets the event: tickets of its departments, a move from or into them, its own access changes. */
export function deliverable({ event, departmentId }: RoutedEvent, scope: DepartmentScope, userId: string): boolean {
  switch (event.type) {
    case 'access.changed':
      return event.userId === userId;
    case 'ticket.moved':
      return canSeeDepartment(scope, event.from) || canSeeDepartment(scope, event.to);
    default:
      // A ticket that is gone, or whose department could not be read, goes only to those who see every department.
      return departmentId === undefined ? scope.all : canSeeDepartment(scope, departmentId);
  }
}
