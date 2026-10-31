import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
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
