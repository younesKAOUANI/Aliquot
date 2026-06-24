import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

import type { Page } from '../common/cursor';
import type { RequestContext } from '../database/request-context';
import { Ctx } from '../http/principal';
import type { AliquotRequest } from '../http/principal';
import { parseWith } from '../http/zod-validation';
import { idempotencyKeyOf } from './idempotency.service';
import { RunService } from './run.service';
import type { RunDetail, RunMutationResult, RunSummary, SealResult } from './run.service';
import { RUN_STATES } from './run-state-machine';

/**
 * The ingestion API.
 *
 * Three of the five mutations require an `Idempotency-Key`, and it is required
 * rather than honoured-if-present on purpose: the clients are instrument agents
 * on lab networks that retry on any timeout, and an endpoint that accepts an
 * unkeyed retry is an endpoint that will eventually register the same
 * acquisition twice. Abandonment is exempt because it is naturally idempotent --
 * the second attempt finds a run that is no longer open and is told so.
 *
 * Every parameter crosses a Zod schema, path parameters included. A malformed
 * uuid that reaches a `::uuid` cast comes back as a 500 that reads like an
 * outage; rejected here it is a 400 that names the field.
 */

/** Long enough for a 4K acquisition with per-channel stacks; short of a request that should have been a batch. */
const MAX_MANIFEST_ENTRIES = 10_000;
const MAX_REASON_LENGTH = 1_000;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const UNSIGNED_DECIMAL = /^(0|[1-9]\d*)$/;
const MEDIA_TYPE =
  /^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}$/;

/** Accepted with or without an offset; stored as declared and never used for ordering. */
const timestamp = z.iso.datetime({ offset: true });
const reason = z.string().trim().min(1).max(MAX_REASON_LENGTH);

/**
 * A size arrives as a JSON number or as a decimal string and is normalised to a
 * string either way. `declared_size` is a bigint, and the manifest digest is
 * taken over one spelling of it -- see `manifest.ts`.
 */
const sizeBytes = z
  .union([
    z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    z.string().regex(UNSIGNED_DECIMAL, 'must be an unsigned decimal integer'),
  ])
  .transform((value) => (typeof value === 'number' ? String(value) : value));

const manifestEntrySchema = z.object({
  logicalName: z.string().min(1).max(512),
  digest: z.string().regex(SHA256_HEX, 'must be 64 lower-case hex characters'),
  sizeBytes,
  mediaType: z
    .string()
    .regex(MEDIA_TYPE, 'must be a media type')
    .default('application/octet-stream'),
});

const manifestSchema = z.array(manifestEntrySchema).min(1).max(MAX_MANIFEST_ENTRIES);

const registerSchema = z.object({
  instrumentId: z.uuid(),
  operatorId: z.uuid().optional(),
  acquiredAt: timestamp.optional(),
  protocol: z.record(z.string(), z.unknown()).optional(),
  manifest: manifestSchema,
});

/**
 * A correction restates the acquisition in full. Study is inherited from the
 * predecessor -- moving a corrected run to another study would make the citation
 * that pointed at the original mean something different -- and instrument and
 * operator default to it.
 */
const supersedeSchema = z.object({
  reason,
  instrumentId: z.uuid().optional(),
  operatorId: z.uuid().optional(),
  acquiredAt: timestamp.optional(),
  protocol: z.record(z.string(), z.unknown()).optional(),
  manifest: manifestSchema,
});

const abandonSchema = z.object({ reason });

/** Sealing takes no arguments; the schema exists so that a body carrying some cannot imply otherwise. */
const sealSchema = z.object({});

const studyParamsSchema = z.object({ studyId: z.uuid() });
const runParamsSchema = z.object({ runId: z.uuid() });

const runState = z.enum(RUN_STATES);

const searchSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(512).optional(),
  studyId: z.uuid().optional(),
  instrumentId: z.uuid().optional(),
  operatorId: z.uuid().optional(),
  // Repeated `?state=` parameters arrive as an array; one arrives as a string.
  state: z.union([runState, z.array(runState).min(1)]).optional(),
  acquiredFrom: timestamp.optional(),
  acquiredTo: timestamp.optional(),
});

@Controller('v1')
export class RunController {
  constructor(private readonly runs: RunService) {}

  @Post('studies/:studyId/runs')
  async register(
    @Ctx() ctx: RequestContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Req() request: AliquotRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<RunMutationResult> {
    const { studyId } = parseWith(studyParamsSchema, params, 'params');
    const input = parseWith(registerSchema, body ?? {}, 'body');

    const result = await this.runs.register(ctx, studyId, input, idempotencyKeyOf(request.headers));

    // The stored status, not a constant: a replay answers with what the original
    // request answered, which is the property the record exists to provide.
    reply.status(result.status);
    return result.body;
  }

  @Get('runs')
  async search(@Ctx() ctx: RequestContext, @Query() query: unknown): Promise<Page<RunSummary>> {
    const input = parseWith(searchSchema, query, 'query');
    const state = input.state === undefined ? undefined : normaliseStates(input.state);

    return this.runs.search(ctx, {
      limit: input.limit,
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      ...(input.studyId !== undefined ? { studyId: input.studyId } : {}),
      ...(input.instrumentId !== undefined ? { instrumentId: input.instrumentId } : {}),
      ...(input.operatorId !== undefined ? { operatorId: input.operatorId } : {}),
      ...(state !== undefined ? { state } : {}),
      ...(input.acquiredFrom !== undefined ? { acquiredFrom: input.acquiredFrom } : {}),
      ...(input.acquiredTo !== undefined ? { acquiredTo: input.acquiredTo } : {}),
    });
  }

  @Get('runs/:runId')
  async get(@Ctx() ctx: RequestContext, @Param() params: unknown): Promise<RunDetail> {
    const { runId } = parseWith(runParamsSchema, params, 'params');
    return this.runs.get(ctx, runId);
  }

  @Post('runs/:runId/seal')
  async seal(
    @Ctx() ctx: RequestContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Req() request: AliquotRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SealResult> {
    const { runId } = parseWith(runParamsSchema, params, 'params');
    parseWith(sealSchema, body ?? {}, 'body');

    const result = await this.runs.seal(ctx, runId, idempotencyKeyOf(request.headers));

    reply.status(result.status);
    return result.body;
  }

  @Post('runs/:runId/abandon')
  @HttpCode(200)
  async abandon(
    @Ctx() ctx: RequestContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<RunMutationResult> {
    const { runId } = parseWith(runParamsSchema, params, 'params');
    const input = parseWith(abandonSchema, body ?? {}, 'body');

    return this.runs.abandon(ctx, runId, input.reason);
  }

  @Post('runs/:runId/supersede')
  async supersede(
    @Ctx() ctx: RequestContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Req() request: AliquotRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<RunMutationResult> {
    const { runId } = parseWith(runParamsSchema, params, 'params');
    const input = parseWith(supersedeSchema, body ?? {}, 'body');

    const result = await this.runs.supersede(ctx, runId, input, idempotencyKeyOf(request.headers));

    reply.status(result.status);
    return result.body;
  }
}

function normaliseStates(state: z.infer<typeof runState> | z.infer<typeof runState>[]) {
  return Array.isArray(state) ? state : [state];
}
