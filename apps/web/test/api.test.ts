import { describe, expect, it } from 'vitest';
import { ApiError, toApiError } from '../app/utils/api';

describe('toApiError', () => {
  it('takes the code and the message from the API error body', () => {
    const error = toApiError({ status: 409, data: { error: { code: 'conflict', message: 'Taken' } } });

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'conflict', message: 'Taken' });
  });

  it('recognizes an unavailable server', () => {
    expect(toApiError(new TypeError('fetch failed'))).toMatchObject({ status: 0, code: 'network_error' });
  });

  it('falls back to the status without a body', () => {
    expect(toApiError({ statusCode: 502, message: 'Bad Gateway' })).toMatchObject({ status: 502, code: 'error' });
  });
});
