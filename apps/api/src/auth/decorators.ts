import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { ApiTokenScope } from '@kvitok/shared';
import type { AuthContext } from '../common/request';
import type { AppRequest } from '../common/request';

export const IS_PUBLIC = 'isPublic';

/** The route is available without a session. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const CurrentAuth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  const request = ctx.switchToHttp().getRequest<AppRequest>();
  if (request.auth === undefined) {
    throw new Error('CurrentAuth used on a public route');
  }
  return request.auth;
});

export const REQUIRED_SCOPE = 'requiredTokenScope';

/**
 * Opens a non-GET route to personal access tokens with this scope.
 * GET routes need `read`; any other route without this decorator is closed to tokens.
 */
export const RequireScope = (scope: ApiTokenScope) => SetMetadata(REQUIRED_SCOPE, scope);
