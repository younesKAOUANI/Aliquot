import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

import { NotFoundError } from '../common/problem-details';
import type { RequestContext } from '../database/request-context';
import { Ctx } from '../http/principal';
import { parseWith } from '../http/zod-validation';
import type { CompletedPart } from '../storage/object-store';
import { UploadService } from './upload.service';
import type {
  ArtifactView,
  BeginResult,
  CompleteResult,
  RecordedPartResult,
} from './upload.service';

/**
 * ## Why the three upload routes are one handler
 *
 * The documented API is
 *
 *     POST /v1/runs/{runId}/artifacts/{name}/upload
 *     POST /v1/runs/{runId}/artifacts/{name}/upload/parts
 *     POST /v1/runs/{runId}/artifacts/{name}/upload/complete
 *
 * where `{name}` is a logical name such as `ch0/stack.tif`. Logical names carry
 * slashes because instruments write directory trees and flattening one loses
 * information the scientist relies on, so `{name}` has to span several path
 * segments.
 *
 * Fastify routes through find-my-way, and find-my-way permits exactly one
 * spelling of a multi-segment parameter: a bare `*`, as the final character of
 * the route. A named wildcard (`*name`) is rejected outright, and so is any
 * wildcard with a suffix after it -- `/artifacts/*name/upload` raises "Wildcard
 * must be the last character in the route" at registration time. That is a
 * router constraint, not a Nest one, and it is not configurable.
 *
 * Two options were available. Move the name to the end of the path
 * (`POST /v1/runs/{runId}/upload-complete/{name}`), which routes cleanly and
 * changes every documented URL; or register one terminal wildcard and split the
 * operation off the end of the captured tail. The second keeps the published
 * URLs literally correct, which matters more here than the tidiness of three
 * decorators -- the clients are instrument agents shipped by vendors, and a URL
 * shape is the part of an API they hard-code.
 *
 * The split is unambiguous. A tail ends with `/upload`, `/upload/parts` or
 * `/upload/complete`, and no string ends with more than one of the three, so the
 * name is whatever remains after removing the suffix. A logical name that itself
 * contains a segment called `upload` still parses correctly:
 * `ch0/upload/upload` is the artifact `ch0/upload` beginning an upload.
 *
 * find-my-way percent-decodes the wildcard before we see it, so a client that
 * encoded the separators as `%2F` arrives at the same tail as one that did not,
 * and decoding again here would corrupt any name containing a literal `%`.
 */

const UPLOAD_OPERATIONS = [
  { suffix: '/upload/complete', operation: 'complete' },
  { suffix: '/upload/parts', operation: 'parts' },
  { suffix: '/upload', operation: 'begin' },
] as const;

type UploadOperation = (typeof UPLOAD_OPERATIONS)[number]['operation'];

/** The same pattern the `run_artifact.logical_name` CHECK constraint enforces. */
const LOGICAL_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;

const runIdSchema = z.uuid();
const artifactIdSchema = z.uuid();

/**
 * A byte count as either a JSON number or a decimal string.
 *
 * Part sizes cannot exceed 5 GiB, so a number is safe here in a way it is not
 * for artifact sizes -- but accepting the string spelling too means a client
 * that renders every size as a string, which is the only thing it can do for the
 * artifact-level fields, does not have to make an exception for this one.
 */
const byteCount = z.union([
  z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  z.string().regex(/^\d+$/, 'must be a decimal byte count'),
]);

const recordPartSchema = z.object({
  sessionId: z.uuid(),
  partNumber: z.number().int().min(1).max(10_000),
  /** The entity tag the object store returned for the part. Quotes optional. */
  etag: z.string().min(1).max(256),
  sizeBytes: byteCount,
});

const completeSchema = z.object({
  /**
   * Optional: a client that recorded each part as it finished has already told
   * us the entity tags, and repeating them is busywork for a 10,000-part upload.
   */
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().min(1).max(10_000),
        etag: z.string().min(1).max(256),
      }),
    )
    .max(10_000)
    .default([]),
});

@Controller('v1')
export class UploadController {
  constructor(private readonly uploads: UploadService) {}

  @Post('runs/:runId/artifacts/*')
  @HttpCode(200)
  async upload(
    @Ctx() ctx: RequestContext,
    @Param('runId') rawRunId: string,
    @Param('*') tail: string,
    @Body() body: unknown,
  ): Promise<BeginResult | RecordedPartResult | CompleteResult> {
    const runId = parseWith(runIdSchema, rawRunId, 'params');
    const target = splitOperation(tail);

    switch (target.operation) {
      case 'begin':
        return this.uploads.begin(ctx, runId, target.logicalName);

      case 'parts': {
        const input = parseWith(recordPartSchema, body ?? {}, 'body');
        return this.uploads.recordPart(
          ctx,
          input.sessionId,
          input.partNumber,
          input.etag,
          BigInt(input.sizeBytes),
        );
      }

      case 'complete': {
        const input = parseWith(completeSchema, body ?? {}, 'body');
        const parts: CompletedPart[] = input.parts.map((part) => ({
          partNumber: part.partNumber,
          etag: part.etag,
        }));
        return this.uploads.complete(ctx, runId, target.logicalName, parts);
      }
    }
  }

  @Get('artifacts/:artifactId')
  async artifact(
    @Ctx() ctx: RequestContext,
    @Param('artifactId') rawArtifactId: string,
  ): Promise<ArtifactView> {
    return this.uploads.artifact(ctx, parseWith(artifactIdSchema, rawArtifactId, 'params'));
  }

  /**
   * A redirect rather than a proxied body.
   *
   * 302 and not 307: the client is being sent to a different resource with a
   * different, signed URL, and there is no request body to preserve. `no-store`
   * is on the redirect itself because the `Location` header contains a live
   * capability -- a cached 302 in a shared proxy hands that capability to
   * whoever asks next.
   */
  @Get('artifacts/:artifactId/download')
  async download(
    @Ctx() ctx: RequestContext,
    @Param('artifactId') rawArtifactId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const artifactId = parseWith(artifactIdSchema, rawArtifactId, 'params');
    const { url } = await this.uploads.downloadUrl(ctx, artifactId);

    await reply.status(302).header('location', url).header('cache-control', 'no-store').send();
  }
}

function splitOperation(tail: string): { logicalName: string; operation: UploadOperation } {
  for (const candidate of UPLOAD_OPERATIONS) {
    if (!tail.endsWith(candidate.suffix)) continue;

    const logicalName = tail.slice(0, tail.length - candidate.suffix.length);
    if (!LOGICAL_NAME.test(logicalName)) break;

    return { logicalName, operation: candidate.operation };
  }

  // The wildcard matches anything under `/artifacts/`, so a path that names no
  // operation reaches this handler rather than Nest's own 404. Answering with
  // one keeps that invisible to the caller.
  throw new NotFoundError('upload endpoint', tail);
}
