import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { errors } from '../common/errors';
import type { AppRequest } from '../common/request';
import { AuthService } from './auth.service';
import { IS_PUBLIC } from './decorators';
import { SESSION_COOKIE } from './session-token';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AppRequest>();
    const token = request.cookies?.[SESSION_COOKIE];
    const auth = token ? await this.authService.authenticate(token) : null;
    if (auth === null) {
      throw errors.unauthorized();
    }

    request.auth = auth;
    return true;
  }
}
