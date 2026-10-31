import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { errors } from './errors';

describe('AllExceptionsFilter.toBody', () => {
  const filter = new AllExceptionsFilter();

  it('keeps the AppError body as is', () => {
    expect(filter.toBody(errors.conflict('Занято'))).toEqual({
      status: 409,
      body: { error: { code: 'conflict', message: 'Занято' } },
    });
  });

  it('converts standard Nest exceptions to our format', () => {
    expect(filter.toBody(new NotFoundException('Нет такого'))).toEqual({
      status: 404,
      body: { error: { code: 'not_found', message: 'Нет такого' } },
    });
    expect(filter.toBody(new BadRequestException()).body.error.code).toBe('validation_failed');
    expect(filter.toBody(new HttpException('Too Many Requests', 429)).body.error.code).toBe('too_many_requests');
  });

  it('hides the details of unknown errors', () => {
    expect(filter.toBody(new Error('db password leaked'))).toEqual({
      status: 500,
      body: { error: { code: 'internal_error', message: 'Internal error' } },
    });
  });
});
