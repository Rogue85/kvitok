export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export const ERROR_CODES = {
  validationFailed: 'validation_failed',
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  notFound: 'not_found',
  conflict: 'conflict',
  tooManyRequests: 'too_many_requests',
  internal: 'internal_error',
} as const;
