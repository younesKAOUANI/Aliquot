import type { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

import { ValidationError } from '../common/problem-details';

/**
 * The boundary where untrusted input becomes a type.
 *
 * Nest's own `ValidationPipe` is the obvious alternative and it was not taken:
 * it derives its rules from `class-validator` decorators on a class, which means
 * the runtime shape and the compile-time shape are two declarations that agree
 * only by convention. A Zod schema is one declaration, and `z.infer` makes the
 * static type a consequence of the runtime check rather than a parallel claim
 * about it.
 *
 * Everything crossing the HTTP edge goes through here -- body, query and path
 * parameters alike. Path parameters look safe and are not: they reach `::uuid`
 * casts and cursor decoders that report a malformed value as a 500 unless
 * something rejected it as a 400 first.
 */

export type ValidationSource = 'body' | 'query' | 'params';

/**
 * A Zod issue flattened into something that survives JSON serialisation.
 *
 * `path` is joined rather than passed through as an array because it is read by
 * humans and by generic clients, and `["parts", 0, "etag"]` is worse than
 * `parts.0.etag` for both.
 */
export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

export function parseWith<T>(
  schema: z.ZodType<T>,
  input: unknown,
  source: ValidationSource = 'body',
): T {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }

  const issues: ValidationIssue[] = result.error.issues.map((issue) => ({
    // A symbol key cannot come from JSON, but the path type admits one and
    // `Array.prototype.join` throws on symbols rather than rendering them.
    path: issue.path.map((segment) => String(segment)).join('.'),
    code: issue.code,
    message: issue.message,
  }));

  const first = issues[0];
  const summary =
    first === undefined
      ? `${source} failed validation`
      : `${source}${first.path ? ` ${first.path}` : ''}: ${first.message}`;

  throw new ValidationError(
    issues.length > 1 ? `${summary} (and ${issues.length - 1} more)` : summary,
    issues,
  );
}

/**
 * Pipe form, for `@Body(new ZodValidationPipe(schema))`.
 *
 * Handlers that want the inferred type without repeating it are better served by
 * calling `parseWith` directly on an `unknown` parameter: the pipe cannot tell
 * the compiler what it produced, so the parameter's annotation is an unchecked
 * assertion about the schema.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: z.ZodType<T>) {}

  transform(value: unknown, metadata: ArgumentMetadata): T {
    return parseWith(this.schema, value, sourceOf(metadata));
  }
}

function sourceOf(metadata: ArgumentMetadata): ValidationSource {
  switch (metadata.type) {
    case 'query':
      return 'query';
    case 'param':
      return 'params';
    default:
      return 'body';
  }
}
