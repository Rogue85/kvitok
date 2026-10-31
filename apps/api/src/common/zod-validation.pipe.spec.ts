import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from './errors';
import { ZodValidationPipe } from './zod-validation.pipe';

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(z.object({ name: z.string().trim().min(1), age: z.number().optional() }));

  it('returns the parsed data', () => {
    expect(pipe.transform({ name: '  Ann ' })).toEqual({ name: 'Ann' });
  });

  it('throws 422 with error paths', () => {
    try {
      pipe.transform({ name: '', age: 'x' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.getStatus()).toBe(422);
      expect(appError.getResponse()).toMatchObject({
        error: {
          code: 'validation_failed',
          details: [expect.objectContaining({ path: 'name' }), expect.objectContaining({ path: 'age' })],
        },
      });
    }
  });

  it('an empty body is validated as an empty object', () => {
    expect(() => pipe.transform(undefined)).toThrow(AppError);
  });
});
