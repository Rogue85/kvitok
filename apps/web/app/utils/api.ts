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

/** Requests whose 401 is an answer, not an ended session. */
const SIGN_IN_PATHS = new Set(['/auth/login', '/auth/me']);

/** Request to the API through the `/api` proxy; errors are converted to ApiError. */
export async function api<T>(path: string, options: { method?: Method; body?: unknown } = {}): Promise<T> {
  try {
    return await $fetch<T>(`/api${path}`, {
      method: options.method ?? 'GET',
      body: options.body as Record<string, unknown> | undefined,
      credentials: 'include',
    });
  } catch (error) {
    const apiError = toApiError(error);
    // The session ended elsewhere: signed out on another device, a changed password, a disabled user.
    // A full reload drops the cached user, and the sign-in returns to this page.
    if (apiError.status === 401 && !SIGN_IN_PATHS.has(path) && window.location.pathname !== '/login') {
      window.location.assign(`/login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    }
    throw apiError;
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
