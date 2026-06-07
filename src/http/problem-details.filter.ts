import { Catch, HttpException } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import {
  AliquotError,
  ConflictError,
  ForbiddenError,
  IdempotentRequestInFlightError,
  PROBLEM_CONTENT_TYPE,
  ProblemType,
} from '../common/problem-details';
import type { ProblemDetails } from '../common/problem-details';
import { Logger } from '../observability/logger';
import { CORRELATION_HEADER, correlationIdOf } from './correlation';
import type { AliquotRequest } from './principal';

/**
 * The single place an exception becomes an HTTP response.
 *
 * Two things this filter is responsible for beyond formatting. The first is that
 * an unrecognised exception produces a 500 whose body says nothing: an
 * unplanned error message is precisely the kind of thing that carries a table
 * name, a file path or a connection string, and the caller cannot act on it
 * anyway. The correlation id is the compensating affordance -- it is on every
 * problem document and in every log line, so a support request can be answered
 * without the caller ever seeing the internals.
 *
 * The second is translating the invariants the database enforces. Most of this
 * service's rules live in triggers and constraints on purpose, and a rule that
 * fires must not reach the client as "internal server error" -- a sealed run
 * rejecting an update is the system working, and the caller needs to be told
 * that in a form it can act on.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<AliquotRequest>();
    const reply = http.getResponse<FastifyReply>();

    const correlationId = correlationIdOf(request);
    const { error, unexpected } = normalise(exception);

    const problem: ProblemDetails = {
      ...error.toProblem(request.url),
      correlationId,
    };

    this.log(problem, exception, unexpected, request, correlationId);

    reply.status(problem.status).header(CORRELATION_HEADER, correlationId);

    if (exception instanceof IdempotentRequestInFlightError) {
      // The caller is being told to come back, so tell it when. Without this a
      // client retries immediately, collides with the in-flight request again,
      // and turns a transient conflict into a hot loop.
      reply.header('retry-after', String(exception.retryAfterSeconds));
    }

    reply.type(PROBLEM_CONTENT_TYPE).send(problem);
  }

  private log(
    problem: ProblemDetails,
    exception: unknown,
    unexpected: boolean,
    request: AliquotRequest,
    correlationId: string,
  ): void {
    const fields = {
      correlationId,
      method: request.method,
      url: request.url,
      status: problem.status,
      type: problem.type,
    };

    if (unexpected || problem.status >= 500) {
      this.logger.error('request failed', {
        ...fields,
        error: exception instanceof Error ? exception.message : String(exception),
        // The stack is the only record of what actually happened, since the
        // response deliberately carries none of it.
        stack: exception instanceof Error ? exception.stack : undefined,
      });
      return;
    }

    // A 4xx is the service working as designed. It is logged so a caller's
    // "it returns 409" can be traced, but at a level that does not page anyone.
    this.logger.warn('request rejected', { ...fields, detail: problem.detail });
  }
}

interface Normalised {
  error: AliquotError;
  /** True when nothing recognised the exception, which is the only case that logs a stack. */
  unexpected: boolean;
}

function normalise(exception: unknown): Normalised {
  if (exception instanceof AliquotError) {
    return { error: exception, unexpected: false };
  }

  const fromDatabase = fromPostgres(exception);
  if (fromDatabase) {
    return { error: fromDatabase, unexpected: false };
  }

  if (exception instanceof HttpException) {
    return { error: fromHttpException(exception), unexpected: false };
  }

  return {
    error: new AliquotError(
      ProblemType.INTERNAL,
      500,
      'Internal server error',
      'The request could not be completed. Quote the correlation id when reporting this.',
    ),
    unexpected: true,
  };
}

/**
 * Driver-level shape of a PostgreSQL error.
 *
 * Matched structurally rather than with `instanceof DatabaseError`, because the
 * error crosses Kysely and a pool, and one `instanceof` against a duplicated
 * copy of `pg` in the module graph silently turns every constraint violation
 * back into a 500.
 */
interface PostgresError {
  code: string;
  message: string;
  constraint?: string;
  table?: string;
  routine?: string;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

function asPostgresError(error: unknown): PostgresError | null {
  if (typeof error !== 'object' || error === null) return null;

  // `severity` is what distinguishes a PostgreSQL error from any other object
  // carrying a five-character `code` -- Node's own `EPIPE` is five uppercase
  // characters and is not a constraint violation.
  if (!('severity' in error) || typeof error.severity !== 'string') return null;
  if (!('code' in error) || typeof error.code !== 'string' || !SQLSTATE.test(error.code)) {
    return null;
  }

  return {
    code: error.code,
    message: stringField(error, 'message') ?? '',
    constraint: stringField(error, 'constraint'),
    table: stringField(error, 'table'),
    routine: stringField(error, 'routine'),
  };
}

function stringField(source: object, key: string): string | undefined {
  if (!(key in source)) return undefined;
  const value: unknown = Reflect.get(source, key);
  return typeof value === 'string' ? value : undefined;
}

function fromPostgres(exception: unknown): AliquotError | null {
  const error = asPostgresError(exception);
  if (!error) return null;

  switch (error.code) {
    case '23505':
      // Unique violations are how idempotency, content addressing and
      // `derivation_identity_unique` are enforced, so this is a routine outcome
      // of a correct race rather than a failure. The constraint name is part of
      // the schema and safe to name; PostgreSQL's `detail` is not returned
      // because it quotes the offending row values back.
      return new ConflictError(
        `A conflicting row already exists${error.constraint ? ` (${error.constraint})` : ''}.`,
        { ...(error.constraint ? { constraint: error.constraint } : {}) },
      );

    case '23514':
      return new AliquotError(
        ProblemType.VALIDATION_FAILED,
        422,
        'Value rejected by a stored constraint',
        `The request is well-formed but a stored constraint rejected a value${
          error.constraint ? ` (${error.constraint})` : ''
        }.`,
        { ...(error.constraint ? { constraint: error.constraint } : {}) },
      );

    case '23000':
      // The bare class code is what our own triggers raise
      // (`errcode = 'integrity_constraint_violation'`): run immutability,
      // manifest freezing, the append-only audit tables. Those messages are
      // written by us, name only ids the caller already holds, and are the most
      // useful thing we can say -- "run X is sealed" beats "conflict".
      return new ConflictError(error.message, {
        ...(error.table ? { resource: error.table } : {}),
      });

    case '42501':
      // Either a genuine grant failure or `append_audit_event` refusing to write
      // an unattributable event. The message is withheld: the first case names
      // tables and roles. The second is a bug on our side and shows up in the
      // log with everything needed to find it.
      return new ForbiddenError('The database refused this operation for the current session.');

    default:
      return null;
  }
}

/**
 * Nest's own exceptions -- the 404 from an unmatched route, a guard's
 * `ForbiddenException`, the adapter's payload-too-large. Mapped onto the problem
 * vocabulary where one applies, and onto RFC 9457's `about:blank` where none
 * does, which is what the RFC says to use when a problem has no semantics beyond
 * its status code.
 */
const BY_STATUS = new Map<number, { type: string; title: string }>([
  [400, { type: ProblemType.VALIDATION_FAILED, title: 'Request validation failed' }],
  [401, { type: ProblemType.UNAUTHENTICATED, title: 'Unauthenticated' }],
  [403, { type: ProblemType.FORBIDDEN, title: 'Forbidden' }],
  [404, { type: ProblemType.NOT_FOUND, title: 'Not found' }],
  [409, { type: ProblemType.CONFLICT, title: 'Conflict' }],
  [422, { type: ProblemType.VALIDATION_FAILED, title: 'Unprocessable content' }],
  [500, { type: ProblemType.INTERNAL, title: 'Internal server error' }],
]);

function fromHttpException(exception: HttpException): AliquotError {
  const status = exception.getStatus();
  const mapped = BY_STATUS.get(status) ?? {
    type: 'about:blank',
    title: status >= 500 ? 'Internal server error' : 'Request failed',
  };

  const body = exception.getResponse();
  const detail = status >= 500 ? undefined : detailOf(body);

  return new AliquotError(mapped.type, status, mapped.title, detail);
}

function detailOf(body: string | object): string | undefined {
  if (typeof body === 'string') return body;
  if (!('message' in body)) return undefined;

  const message: unknown = body.message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) {
    return message.map((entry) => String(entry)).join('; ');
  }
  return undefined;
}
