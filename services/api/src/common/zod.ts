import { BadRequestException } from '@nestjs/common';
import { formatZodIssues } from '@growthos/shared-types';
import type { ZodTypeAny, output } from 'zod';

/** Parses input with a zod schema or throws a 400 with readable issues. */
export function parseOrThrow<S extends ZodTypeAny>(schema: S, value: unknown): output<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new BadRequestException({
      error: 'validation_failed',
      message: formatZodIssues(r.error),
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}
