import type { ApiErrorBody } from '@kvitok/shared';
import { t } from './i18n';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** Request to the API through the `/api` proxy; errors are converted to ApiError. */
export async function api<T>(path: string, options: { method?: Method; body?: unknown } = {}): Promise<T> {
  try {
    return await $fetch<T>(`/api${path}`, {
      method: options.method ?? 'GET',
      body: options.body as Record<string, unknown> | undefined,
      credentials: 'include',
    });
  } catch (error) {
    throw toApiError(error);
  }
}

export function toApiError(error: unknown): ApiError {
  const fetchError = error as { status?: number; statusCode?: number; data?: Partial<ApiErrorBody>; message?: string };
  const status = fetchError.status ?? fetchError.statusCode ?? 0;
  const body = fetchError.data?.error;
  if (body?.code) {
    return new ApiError(status, body.code, body.message ?? t('common.error'), body.details);
  }
  return new ApiError(status, status === 0 ? 'network_error' : 'error', status === 0 ? t('common.serverUnavailable') : (fetchError.message ?? t('common.error')));
}
