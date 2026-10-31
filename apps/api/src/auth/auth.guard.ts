import { t } from '@kvitok/i18n';
import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ApiTokenScope } from '@kvitok/shared';
import { errors } from '../common/errors';
import type { AppRequest, TokenContext } from '../common/request';
import { ApiTokensService } from './api-tokens.service';
import { AuthService } from './auth.service';
import { IS_PUBLIC, REQUIRED_SCOPE } from './decorators';
import { SESSION_COOKIE } from './session-token';

const READ_METHODS = new Set(['GET', 'HEAD']);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
    private readonly apiTokens: ApiTokensService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AppRequest>();
    const bearer = bearerToken(request.headers.authorization);
    let auth;
    if (bearer !== null) {
      auth = await this.apiTokens.authenticate(bearer);
    } else {
      const token = request.cookies?.[SESSION_COOKIE];
      auth = token ? await this.authService.authenticate(token) : null;
    }
    if (auth === null) {
      throw errors.unauthorized();
    }
    if (auth.token !== null) {
      this.checkScope(context, request.method, auth.token);
    }

    request.auth = auth;
    return true;
  }

  private checkScope(context: ExecutionContext, method: string, token: TokenContext): void {
    const required: ApiTokenScope | undefined = READ_METHODS.has(method)
      ? 'read'
      : this.reflector.getAllAndOverride<ApiTokenScope | undefined>(REQUIRED_SCOPE, [context.getHandler(), context.getClass()]);
    if (required === undefined) {
      throw errors.forbidden(t('api.tokenRouteClosed'));
    }
    if (!token.scopes.includes(required)) {
      throw errors.forbidden(t('api.tokenScopeMissing', { scope: required }));
    }
  }
}

function bearerToken(header: string | undefined): string | null {
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}
