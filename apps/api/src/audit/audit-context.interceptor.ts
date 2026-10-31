import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { AppRequest } from '../common/request';
import { actorOf, runAs } from './audit-context';

/** Runs the handler on behalf of the authenticated user, so services can record who made a change. */
@Injectable()
export class AuditContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const auth = context.switchToHttp().getRequest<AppRequest>().auth;
    if (auth === undefined) {
      return next.handle();
    }
    const actor = actorOf(auth);
    // The handler starts on subscription, so it and everything it awaits run inside the context.
    return new Observable((subscriber) => runAs(actor, () => next.handle().subscribe(subscriber)));
  }
}
