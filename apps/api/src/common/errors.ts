import { t } from '@kvitok/i18n';
import { HttpException, HttpStatus } from '@nestjs/common';
import { ERROR_CODES, type ApiErrorBody } from '@kvitok/shared';

export class AppError extends HttpException {
  constructor(status: HttpStatus, code: string, message: string, details?: unknown) {
    const body: ApiErrorBody = { error: { code, message, ...(details === undefined ? {} : { details }) } };
    super(body, status);
  }
}

export const errors = {
  validation: (details: unknown, message = t('api.errors.validation')) =>
    new AppError(HttpStatus.UNPROCESSABLE_ENTITY, ERROR_CODES.validationFailed, message, details),
  unauthorized: (message = t('api.errors.unauthorized')) => new AppError(HttpStatus.UNAUTHORIZED, ERROR_CODES.unauthorized, message),
  forbidden: (message = t('api.errors.forbidden')) => new AppError(HttpStatus.FORBIDDEN, ERROR_CODES.forbidden, message),
  notFound: (message = t('api.errors.notFound')) => new AppError(HttpStatus.NOT_FOUND, ERROR_CODES.notFound, message),
  conflict: (message: string) => new AppError(HttpStatus.CONFLICT, ERROR_CODES.conflict, message),
};
