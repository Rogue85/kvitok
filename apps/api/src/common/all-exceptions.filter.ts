import { t } from '@kvitok/i18n';
import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger, type ExceptionFilter } from '@nestjs/common';
import { ERROR_CODES, type ApiErrorBody } from '@kvitok/shared';
import type { FastifyReply } from 'fastify';

const CODE_BY_STATUS: Partial<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: ERROR_CODES.validationFailed,
  [HttpStatus.UNPROCESSABLE_ENTITY]: ERROR_CODES.validationFailed,
  [HttpStatus.UNAUTHORIZED]: ERROR_CODES.unauthorized,
  [HttpStatus.FORBIDDEN]: ERROR_CODES.forbidden,
  [HttpStatus.NOT_FOUND]: ERROR_CODES.notFound,
  [HttpStatus.CONFLICT]: ERROR_CODES.conflict,
  [HttpStatus.TOO_MANY_REQUESTS]: ERROR_CODES.tooManyRequests,
};

/** Converts any error to the `{ error: { code, message, details? } }` format. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const { status, body } = this.toBody(exception);

    if (status >= 500) {
      this.logger.error(exception instanceof Error ? exception.stack ?? exception.message : String(exception));
    }

    void reply.status(status).send(body);
  }

  toBody(exception: unknown): { status: number; body: ApiErrorBody } {
    if (!(exception instanceof HttpException)) {
      return { status: 500, body: { error: { code: ERROR_CODES.internal, message: t('api.errors.internal') } } };
    }

    const status = exception.getStatus();
    const response = exception.getResponse();
    if (isApiErrorBody(response)) {
      return { status, body: response };
    }

    const message =
      typeof response === 'string'
        ? response
        : typeof (response as { message?: unknown }).message === 'string'
          ? (response as { message: string }).message
          : exception.message;

    return {
      status,
      body: { error: { code: CODE_BY_STATUS[status] ?? (status >= 500 ? ERROR_CODES.internal : 'error'), message } },
    };
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as ApiErrorBody).error?.code === 'string'
  );
}
