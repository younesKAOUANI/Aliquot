import { Injectable } from '@nestjs/common';
import type { NestMiddleware } from '@nestjs/common';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

import { uuidv4 } from '../common/uuid';

/**
 * One identifier per request, minted at the edge and carried everywhere.
 *
 * An inbound value is honoured because the callers here are instrument agents
 * and pipeline drivers that already have their own job identifier, and the only
 * way to answer "what happened to run X on the instrument side" is to let them
 * name the request. It is not trusted beyond that: the id ends up in log lines,
 * in `audit_event.correlation_id` and in problem documents, so it is bounded to
 * a length and a charset that cannot forge a log field, smuggle a control
 * character into a terminal, or become an unbounded column value.
 */
export const CORRELATION_HEADER = 'x-correlation-id';

const WELL_FORMED = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Nest middleware under the Fastify adapter runs through middie, which hands it
 * the raw Node request rather than the `FastifyRequest` that guards, controllers
 * and exception filters later see. Writing the accepted id back into the headers
 * is what bridges the two views: `FastifyRequest.headers` is the raw headers
 * object, so downstream code reads the id we accepted rather than the one the
 * client sent.
 */
interface CorrelatedRequest extends IncomingMessage {
  correlationId?: string;
}

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(request: CorrelatedRequest, response: ServerResponse, next: () => void): void {
    const id = acceptableId(request.headers[CORRELATION_HEADER]) ?? uuidv4();

    request.headers[CORRELATION_HEADER] = id;
    request.correlationId = id;
    // Echoed unconditionally, including on error responses: a caller reporting a
    // failure needs the id we filed it under, not the one it hoped we used.
    response.setHeader(CORRELATION_HEADER, id);

    next();
  }
}

/**
 * The correlation id for a request that has already been through the middleware.
 *
 * The fallback path is not dead code. Routes can be reached in unit tests and by
 * a future adapter without the middleware chain, and an absent correlation id is
 * a worse outcome than a late-minted one -- every log line and problem document
 * downstream assumes it has one. The minted value is memoised onto the request
 * so two readers of the same request never disagree.
 */
export function correlationIdOf(request: {
  correlationId?: string;
  headers?: IncomingHttpHeaders;
}): string {
  if (request.correlationId !== undefined && request.correlationId.length > 0) {
    return request.correlationId;
  }

  const id = acceptableId(request.headers?.[CORRELATION_HEADER]) ?? uuidv4();
  request.correlationId = id;
  return id;
}

function acceptableId(header: string | string[] | undefined): string | undefined {
  // A repeated header arrives as an array. Taking the first value rather than
  // joining keeps the id a single token; a client that sent two is confused
  // either way, and the alternative renderings ("a, b") fail the charset check.
  const value = Array.isArray(header) ? header[0] : header;
  return value !== undefined && WELL_FORMED.test(value) ? value : undefined;
}
