import { Body, Controller, Get, HttpCode, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

import type { Page } from '../common/cursor';
import type { RequestContext } from '../database/request-context';
import type { StudyRole } from '../database/schema';
import { AuthService } from '../identity/auth.service';
import { Ctx } from '../http/principal';
import { parseWith } from '../http/zod-validation';
import { AuditService } from './audit.service';
import type { AuditEventView } from './audit.service';
import { ChainVerifier } from './chain-verifier';
import type { ChainVerificationResult } from './chain-verifier';
import { CheckpointService } from './checkpoint.service';
import type { CheckpointRecord } from './checkpoint.service';

/**
 * Read access to the audit trail, plus the two operations that act on the chain
 * itself.
 *
 * Verification and checkpointing require a steward or admin role, and both
 * therefore take a `studyId`: the role model in this service is study-scoped
 * while the audit chain is tenant-scoped, so the caller names the study whose
 * stewardship it is exercising. That is a compromise -- stewardship of one study
 * authorises an operation over the whole tenant's chain -- and the alternative
 * would be inventing a tenant-level role that the authorisation model does not
 * have. Reading the stream needs only authentication: row-level security already
 * confines it to the caller's tenant.
 */

const decimalSeq = z.string().regex(/^\d+$/, 'must be a decimal sequence number');
const cursor = z.string().min(1).max(512);
const limit = z.coerce.number().int().min(1).max(200).default(50);

const listQuerySchema = z.object({
  limit,
  cursor: cursor.optional(),
  action: z
    .string()
    .regex(/^[a-z_]+\.[a-z_]+$/, 'must be <noun>.<verb>')
    .optional(),
  targetType: z.string().min(1).max(64).optional(),
  targetId: z.uuid().optional(),
});

const verifySchema = z.object({
  studyId: z.uuid(),
  fromSeq: decimalSeq.optional(),
});

const checkpointListSchema = z.object({
  limit,
  cursor: cursor.optional(),
});

const createCheckpointSchema = z.object({
  studyId: z.uuid(),
  force: z.boolean().default(false),
  /** Stored verbatim as `external_ref`; this service never dereferences it. */
  externalRef: z.string().min(1).max(512).optional(),
});

const STEWARD_OR_ADMIN: StudyRole[] = ['steward', 'admin'];

@Controller('v1/audit')
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly verifier: ChainVerifier,
    private readonly checkpoints: CheckpointService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  async list(@Ctx() ctx: RequestContext, @Query() query: unknown): Promise<Page<AuditEventView>> {
    return this.audit.list(ctx, parseWith(listQuerySchema, query, 'query'));
  }

  /**
   * A failed verification is reported as a 200 carrying `ok: false`, not as an
   * error status. The request succeeded: the caller asked for the state of the
   * chain and is being told, with the divergence located. Reserving the error
   * path for the operations that must refuse to proceed on a broken chain --
   * checkpointing, in particular -- keeps the distinction meaningful.
   */
  @Post('verify')
  @HttpCode(200)
  async verify(
    @Ctx() ctx: RequestContext,
    @Body() body: unknown,
  ): Promise<ChainVerificationResult> {
    const input = parseWith(verifySchema, body ?? {}, 'body');
    await this.auth.requireStudyRole(ctx, input.studyId, STEWARD_OR_ADMIN);

    return this.verifier.verify(ctx, { fromSeq: input.fromSeq });
  }

  @Get('checkpoints')
  async listCheckpoints(
    @Ctx() ctx: RequestContext,
    @Query() query: unknown,
  ): Promise<Page<CheckpointRecord>> {
    return this.checkpoints.list(ctx, parseWith(checkpointListSchema, query, 'query'));
  }

  @Post('checkpoints')
  async createCheckpoint(
    @Ctx() ctx: RequestContext,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CheckpointRecord> {
    const input = parseWith(createCheckpointSchema, body ?? {}, 'body');
    await this.auth.requireStudyRole(ctx, input.studyId, STEWARD_OR_ADMIN);

    const result = await this.checkpoints.create(ctx, {
      force: input.force,
      ...(input.externalRef !== undefined ? { externalRef: input.externalRef } : {}),
    });

    // 200 rather than 201 when the chain had not moved far enough to warrant a
    // new checkpoint: the caller gets the checkpoint that already covers the
    // head, and nothing was created.
    reply.status(result.created ? 201 : 200);
    return result.checkpoint;
  }
}
