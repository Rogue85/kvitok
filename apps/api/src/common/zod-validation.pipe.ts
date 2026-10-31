import { Injectable, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { errors } from './errors';

@Injectable()
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    // An empty request body is an empty object; for optional query parameters undefined stays undefined.
    const result = this.schema.safeParse(value === undefined && this.schema instanceof z.ZodObject ? {} : value);
    if (!result.success) {
      throw errors.validation(
        result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message, code: issue.code })),
      );
    }
    return result.data;
  }
}
