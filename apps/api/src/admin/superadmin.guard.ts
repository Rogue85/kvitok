import { t } from '@kvitok/i18n';
import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { errors } from '../common/errors';
import type { AppRequest } from '../common/request';

/** Installation management: superadmins only, and only from a sign-in session, never with an access token. */
@Injectable()
export class SuperadminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const auth = context.switchToHttp().getRequest<AppRequest>().auth;
    if (auth === undefined || !auth.user.isSuperadmin) {
      throw errors.forbidden();
    }
    if (auth.token !== null) {
      throw errors.forbidden(t('api.adminNeedsSession'));
    }
    return true;
  }
}
