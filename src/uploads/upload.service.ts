import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService } from '../audit/audit.service';
import { storageKeyForDigest } from '../common/digest';
import {
  AliquotError,
  ConflictError,
  DigestMismatchError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../common/problem-details';
import { uuidv7 } from '../common/uuid';
import { AppConfig } from '../config/config';
import { DatabaseService } from '../database/database.service';
import type { Trx } from '../database/database.service';
import type { RequestContext } from '../database/request-context';
import type { ArtifactVerificationState, RunState, StudyRole } from '../database/schema';
import { AuthService } from '../identity/auth.service';
import { ArtifactNotDeclaredError } from '../ingestion/manifest';
import { RunService } from '../ingestion/run.service';
import { Logger } from '../observability/logger';
import { ObjectStore } from '../storage/object-store';
import type { CompletedPart } from '../storage/object-store';
import { partSpan, planParts } from './part-plan';
import type { PartPlan } from './part-plan';
import { sha256OfStream } from './stream-digest';
import { RunNotOpenError, SizeMismatchError } from './upload.errors';

/**
 * Uploading is a write to the study's data, so it takes the role that is
 * accountable for producing it. A steward is deliberately absent: stewardship is
 * oversight of the record, and letting the reviewer also be the producer
 * collapses a separation the audit trail exists to make visible.
 */
const UPLOAD_ROLES: StudyRole[] = ['operator', 'admin'];
const READ_ROLES: StudyRole[] = ['scientist', 'operator', 'steward', 'admin'];

/**
 * How long an upload session stays resumable.
 *
 * Two orders of magnitude longer than the presigned URL TTL, and that gap is the
 * design rather than an accident. A URL is a capability and wants to be
 * short-lived; a session is bookkeeping about which parts have landed and wants
 * to outlive a weekend and an instrument that was switched off mid-run on a
 * Friday afternoon.
 */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Presigned URLs returned by a single call to `begin`.
 *
 * A 10,000-part upload would otherwise produce a multi-megabyte response full of
 * signatures that mostly expire before the client reaches them. Handing out one
 * window at a time costs nothing, because asking for the next window is exactly
 * the request a resuming client already makes.
 */
const MAX_PRESIGNED_PARTS = 512;

export interface PresignedPart {
  partNumber: number;
  url: string;
  /** Byte offset within the object. A string, because it is a bigint. */
  offset: string;
  sizeBytes: string;
}

/** The digest is already held for this tenant, so no bytes need to move. */
export interface AlreadyPresentResult {
  alreadyPresent: true;
  runArtifactId: string;
  artifactId: string;
  logicalName: string;
  digest: string;
  sizeBytes: string;
  auditSeq: string | null;
}

export interface UploadSessionResult {
  alreadyPresent: false;
  sessionId: string;
  runArtifactId: string;
  logicalName: string;
  storageKey: string;
  /** bigint as string. */
  partSize: string;
  totalParts: number;
  completedParts: number[];
  /** Parts still outstanding. At most `MAX_PRESIGNED_PARTS` of them are signed in `parts`. */
  outstandingParts: number;
  parts: PresignedPart[];
  expiresAt: Date;
  auditSeq: string | null;
}

export type BeginResult = AlreadyPresentResult | UploadSessionResult;

export interface RecordedPartResult {
  sessionId: string;
  partNumber: number;
  etag: string;
  sizeBytes: string;
  completedParts: number;
  totalParts: number;
}

export interface CompleteResult {
  runArtifactId: string;
  artifactId: string;
  logicalName: string;
  digest: string;
  sizeBytes: string;
  /** True when an identical artifact already existed -- a concurrent upload won the race. */
  deduplicated: boolean;
  auditSeq: string | null;
}

export interface ArtifactBinding {
  runId: string;
  logicalName: string;
  studyId: string;
}

export interface ArtifactView {
  id: string;
  digest: string;
  sizeBytes: string;
  mediaType: string;
  firstSeenRunId: string;
  createdAt: Date;
  boundTo: ArtifactBinding[];
}

interface ManifestEntry {
  id: string;
  logicalName: string;
  declaredDigest: string;
  declaredSize: bigint;
  declaredMediaType: string;
  artifactId: string | null;
  verificationState: ArtifactVerificationState;
}

interface OpenSession {
  id: string;
  storageKey: string;
  /** The store's own multipart id. Never leaves this service. */
  storageUploadId: string;
  plan: PartPlan;
  expiresAt: Date;
}

/** What the transaction hands back so signing can happen after it commits. */
interface PreparedUpload {
  alreadyPresent: false;
  entry: ManifestEntry;
  session: OpenSession;
  completedParts: number[];
  auditSeq: string | null;
}

@Injectable()
export class UploadService {
  constructor(
    private readonly database: DatabaseService,
    private readonly store: ObjectStore,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly runs: RunService,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  /**
   * Open or resume the upload of one declared artifact.
   *
   * Calling this again on a session that is already open is how resume works.
   * The response names the parts already recorded and signs fresh URLs for the
   * rest -- fresh, never the ones handed out last time. Presigned URLs expire,
   * and a transfer outliving its URLs is not an edge case here, it is the
   * situation resumability exists for: a 400 GB stack over a lab network takes
   * longer than any signature lifetime short enough to be responsible. Reusing
   * stored URLs would mean either persisting live write capabilities in the
   * database or issuing signatures long enough to matter if one leaks. Minting
   * them per request costs an HMAC and expires the problem.
   */
  async begin(ctx: RequestContext, runId: string, logicalName: string): Promise<BeginResult> {
    await this.authoriseRun(ctx, runId, UPLOAD_ROLES);

    const prepared = await this.database.withTenant<AlreadyPresentResult | PreparedUpload>(
      ctx,
      async (trx) => {
        const { run, entry } = await this.loadEntry(trx, ctx, runId, logicalName);

        if (run.state !== 'OPEN') {
          throw new RunNotOpenError(runId, run.state);
        }
        if (entry.verificationState === 'REJECTED') {
          throw new ConflictError(
            `Artifact ${logicalName} on run ${runId} was rejected; correct it by superseding the run.`,
            { runId, logicalName },
          );
        }

        const bound = entry.artifactId;
        if (entry.verificationState === 'VERIFIED' && bound !== null) {
          // A replay of a call that already succeeded. No second audit event:
          // the event records that the binding happened, and it happened once.
          return this.presentResult(entry, bound, null);
        }

        const deduplicated = await this.bindExistingArtifact(trx, ctx, runId, entry);
        return deduplicated ?? (await this.openOrResumeSession(trx, ctx, runId, entry));
      },
    );

    return prepared.alreadyPresent ? prepared : this.signOutstandingParts(prepared);
  }

  /**
   * Record a part the client says landed. Idempotent by primary key.
   *
   * The object store already knows which parts exist, so this table is redundant
   * with it -- deliberately. Answering "resume from part 412" from our own rows
   * makes resume one indexed read rather than a ListParts round trip on every
   * retry, and it means an object store that lost its multipart state in a local
   * restart cannot quietly look like a completed upload.
   */
  async recordPart(
    ctx: RequestContext,
    sessionId: string,
    partNumber: number,
    etag: string,
    sizeBytes: bigint,
  ): Promise<RecordedPartResult> {
    const owner = await this.database.withTenant(ctx, async (trx) => {
      const row = await trx
        .selectFrom('aliquot.upload_session as s')
        .innerJoin('aliquot.run_artifact as ra', 'ra.id', 's.run_artifact_id')
        .innerJoin('aliquot.run as r', 'r.id', 'ra.run_id')
        .select(['s.state', 's.total_parts', 'r.study_id'])
        .where('s.tenant_id', '=', ctx.tenantId)
        .where('s.id', '=', sessionId)
        .executeTakeFirst();

      if (!row) throw new NotFoundError('upload session', sessionId);
      return row;
    });

    await this.auth.requireStudyRole(ctx, owner.study_id, UPLOAD_ROLES);

    if (owner.state !== 'OPEN') {
      throw new ConflictError(`Upload session ${sessionId} is ${owner.state}.`, {
        sessionId,
        state: owner.state,
      });
    }
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > owner.total_parts) {
      throw new ValidationError(
        `part number ${partNumber} is outside 1..${owner.total_parts} for this session`,
      );
    }
    if (sizeBytes < 0n) {
      throw new ValidationError('part size must not be negative');
    }

    const normalisedEtag = unquote(etag);

    return this.database.withTenant(ctx, async (trx) => {
      await trx
        .insertInto('aliquot.upload_part')
        .values({
          tenant_id: ctx.tenantId,
          upload_session_id: sessionId,
          part_number: partNumber,
          etag: normalisedEtag,
          size_bytes: sizeBytes,
        })
        .onConflict((oc) =>
          // A client retrying a part it already sent gets a new entity tag from
          // the store, and the newest one is what completion has to quote.
          // `completed_at` is untouched: it is insert-only in the schema types,
          // and first-landed is more useful to keep than last-retried.
          oc.columns(['upload_session_id', 'part_number']).doUpdateSet({
            etag: normalisedEtag,
            size_bytes: sizeBytes,
          }),
        )
        .execute();

      const counted = await trx
        .selectFrom('aliquot.upload_part')
        .select(({ fn }) => fn.countAll<string>().as('recorded'))
        .where('tenant_id', '=', ctx.tenantId)
        .where('upload_session_id', '=', sessionId)
        .executeTakeFirst();

      return {
        sessionId,
        partNumber,
        etag: normalisedEtag,
        sizeBytes: sizeBytes.toString(),
        completedParts: Number(counted?.recorded ?? '0'),
        totalParts: owner.total_parts,
      };
    });
  }

  /**
   * Finish the transfer and decide whether to believe it.
   *
   * ## Why the object is read back
   *
   * The obvious verification is the entity tag the store already returned, and
   * it does not work. A multipart ETag is the MD5 of the concatenated part MD5s
   * with the part count appended -- not the object's MD5, let alone its SHA-256,
   * and its value depends on how the client chose to chunk the upload. There is
   * nothing the producer declared that it can be compared against. Some stores
   * can be asked for a SHA-256, and not all of them, and not with the same
   * composition rules; building the guarantee on a capability that varies by
   * vendor is building it on the vendor.
   *
   * So the object is read back and hashed here, streaming, in one pass. This is
   * the honest version and it is expensive: one extra full read of every byte
   * ingested, which at hundreds of gigabytes per artifact is the dominant cost
   * of ingest. That is a real number, not a rounding error, and it is being paid
   * deliberately.
   *
   * The alternative was to trust the declared digest and check only the size.
   * That is nearly free, and it was rejected because it makes the integrity
   * guarantee unfalsifiable: a service that never computes a digest can never
   * report a mismatch, so "every stored byte is verified" stops being a claim
   * that a test can break and becomes one that cannot. A property no test can
   * break is not a property.
   *
   * ## What this does not prove
   *
   * It proves the stored bytes hash to the digest the producer *declared*. That
   * catches every transport failure -- a truncated part, a flipped bit, a proxy
   * that helpfully recompressed something. It does not catch a producer that
   * computed its digest over different bytes than it sent, or simply lied: the
   * declaration and the data come from the same party over the same channel.
   * Closing that gap means computing the digest at acquisition on the instrument
   * itself, which is a different trust boundary and a different piece of
   * software (PRD R16).
   */
  async complete(
    ctx: RequestContext,
    runId: string,
    logicalName: string,
    parts: CompletedPart[],
  ): Promise<CompleteResult> {
    await this.authoriseRun(ctx, runId, UPLOAD_ROLES);

    const prepared = await this.database.withTenant(ctx, async (trx) => {
      const { run, entry } = await this.loadEntry(trx, ctx, runId, logicalName);

      const bound = entry.artifactId;
      if (entry.verificationState === 'VERIFIED' && bound !== null) {
        return { kind: 'done' as const, result: this.completedResult(entry, bound, false, null) };
      }
      if (run.state !== 'OPEN') {
        throw new RunNotOpenError(runId, run.state);
      }

      const session = await this.openSession(trx, ctx, entry.id);
      if (!session) {
        throw new ConflictError(
          `Artifact ${logicalName} on run ${runId} has no open upload session.`,
          { runId, logicalName },
        );
      }

      const recorded = await trx
        .selectFrom('aliquot.upload_part')
        .select(['part_number', 'etag'])
        .where('tenant_id', '=', ctx.tenantId)
        .where('upload_session_id', '=', session.id)
        .orderBy('part_number')
        .execute();

      return { kind: 'verify' as const, entry, session, recorded };
    });

    if (prepared.kind === 'done') {
      return prepared.result;
    }

    const { entry, session, recorded } = prepared;
    await this.finishMultipart(ctx, session, resolveParts(parts, recorded, session, logicalName));

    // The size is taken from a HEAD before the object is read, purely so that an
    // obviously wrong transfer fails in one round trip instead of after
    // streaming three hundred gigabytes through a hash function.
    const head = await this.store.headObject(session.storageKey);
    if (!head) {
      throw new ConflictError(
        'The object store reported this upload complete but the object is not there.',
        { runId, logicalName },
      );
    }
    if (head.sizeBytes !== entry.declaredSize) {
      await this.reject(ctx, runId, entry, session, {
        reason: `stored size ${head.sizeBytes} does not match the declared size ${entry.declaredSize}`,
        detail: { storedSize: head.sizeBytes.toString() },
      });
      throw new SizeMismatchError(logicalName, entry.declaredSize, head.sizeBytes);
    }

    const startedAt = Date.now();
    const read = await sha256OfStream(await this.store.openReadStream(session.storageKey));
    this.logger.info('read stored artifact back for verification', {
      runId,
      logicalName,
      sizeBytes: read.sizeBytes.toString(),
      durationMs: Date.now() - startedAt,
    });

    // The streamed count is an independent measurement. If it disagrees with the
    // HEAD then the store has contradicted itself, and the bytes just hashed are
    // not the bytes it claims to be holding.
    if (read.sizeBytes !== entry.declaredSize) {
      await this.reject(ctx, runId, entry, session, {
        reason: `read back ${read.sizeBytes} bytes for a declared size of ${entry.declaredSize}`,
        detail: { storedSize: read.sizeBytes.toString() },
      });
      throw new SizeMismatchError(logicalName, entry.declaredSize, read.sizeBytes);
    }

    if (read.digest !== entry.declaredDigest) {
      await this.reject(ctx, runId, entry, session, {
        reason: `stored bytes hash to ${read.digest}, declared ${entry.declaredDigest}`,
        detail: { computedDigest: read.digest },
      });
      throw new DigestMismatchError(logicalName, entry.declaredDigest, read.digest);
    }

    return this.bindVerified(ctx, runId, logicalName, session, read.sizeBytes);
  }

  /** Artifact metadata, including every manifest entry that resolves to it. */
  async artifact(ctx: RequestContext, artifactId: string): Promise<ArtifactView> {
    const view = await this.loadArtifact(ctx, artifactId);
    await this.requireAnyStudyRole(ctx, view, READ_ROLES);
    return view;
  }

  /**
   * A time-boxed capability to read exactly this one object.
   *
   * The bytes do not pass through this process on the way out any more than they
   * did on the way in. Streaming a 300 GB artifact through Node would occupy an
   * event loop for the duration of somebody's download, and there is nothing
   * this service could add to those bytes by looking at them.
   */
  async downloadUrl(ctx: RequestContext, artifactId: string): Promise<{ url: string }> {
    const view = await this.loadArtifact(ctx, artifactId);
    await this.requireAnyStudyRole(ctx, view, READ_ROLES);

    const url = await this.store.presignGet(
      storageKeyForDigest(view.digest),
      downloadNameFor(view),
    );
    return { url };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Authorisation happens before the work transaction, not inside it.
   *
   * `requireStudyRole` opens its own tenant transaction, and calling it from
   * within one would hold a connection while waiting for a second connection out
   * of the same pool. That is fine until the pool saturates, at which point it
   * is a deadlock that only appears under load.
   */
  private async authoriseRun(
    ctx: RequestContext,
    runId: string,
    roles: StudyRole[],
  ): Promise<void> {
    const run = await this.database.withTenant(ctx, (trx) =>
      trx
        .selectFrom('aliquot.run')
        .select('study_id')
        .where('id', '=', runId)
        .where('tenant_id', '=', ctx.tenantId)
        .executeTakeFirst(),
    );

    if (!run) throw new NotFoundError('run', runId);
    await this.auth.requireStudyRole(ctx, run.study_id, roles);
  }

  /**
   * The run and the manifest entry, with the entry row locked.
   *
   * The lock is on `run_artifact`, not on `run`. Two callers uploading the same
   * logical name must serialise, and they do; a caller uploading a different
   * artifact of the same run must not be blocked by them, and is not. The run's
   * state is read without a lock on purpose -- if a seal commits underneath us,
   * `enforce_run_artifact_immutability` reads the run's state at statement time
   * and refuses the write, so the database settles that race rather than this
   * check pretending to.
   */
  private async loadEntry(
    trx: Trx,
    ctx: RequestContext,
    runId: string,
    logicalName: string,
  ): Promise<{ run: { id: string; state: RunState }; entry: ManifestEntry }> {
    const run = await trx
      .selectFrom('aliquot.run')
      .select(['id', 'state'])
      .where('id', '=', runId)
      .where('tenant_id', '=', ctx.tenantId)
      .executeTakeFirst();

    if (!run) throw new NotFoundError('run', runId);

    const row = await trx
      .selectFrom('aliquot.run_artifact')
      .select([
        'id',
        'logical_name',
        'declared_digest',
        'declared_size',
        'declared_media_type',
        'artifact_id',
        'verification_state',
      ])
      .where('tenant_id', '=', ctx.tenantId)
      .where('run_id', '=', runId)
      .where('logical_name', '=', logicalName)
      .forUpdate()
      .executeTakeFirst();

    // R2: a name that is not in the manifest is refused here, before anything is
    // created. Accepting it would mean the manifest no longer describes the run,
    // and "every declared artifact is verified" would stop implying "the run is
    // complete" -- which is the only reason to declare a manifest at all.
    if (!row) throw new ArtifactNotDeclaredError(runId, logicalName);

    return {
      run,
      entry: {
        id: row.id,
        logicalName: row.logical_name,
        declaredDigest: row.declared_digest,
        declaredSize: BigInt(row.declared_size),
        declaredMediaType: row.declared_media_type,
        artifactId: row.artifact_id,
        verificationState: row.verification_state,
      },
    };
  }

  /**
   * Bind an artifact this tenant already holds, if there is one.
   *
   * Content addressing paying for itself, which it does constantly: a
   * calibration file shipped with four hundred runs is one object and four
   * hundred bindings. Nothing is presigned, no session is created, and the
   * client is told to skip the transfer entirely -- for a 40 GB reference stack
   * that is the difference between an upload and a database row.
   *
   * Scoped to the tenant, never global. A global lookup would turn the response
   * into an oracle: "already present" for a digest this tenant never uploaded
   * says another tenant holds that exact file, and where the file may be an
   * unpublished result that is a real disclosure (ADR-0017).
   */
  private async bindExistingArtifact(
    trx: Trx,
    ctx: RequestContext,
    runId: string,
    entry: ManifestEntry,
  ): Promise<AlreadyPresentResult | null> {
    const existing = await trx
      .selectFrom('aliquot.artifact')
      .select(['id', 'size_bytes'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('digest', '=', entry.declaredDigest)
      .executeTakeFirst();

    if (!existing) return null;

    const storedSize = BigInt(existing.size_bytes);
    if (storedSize !== entry.declaredSize) {
      // Same digest, different declared size. One of the two declarations is
      // wrong and there is no way to tell which, so nothing is bound and no
      // bytes are accepted on the strength of it.
      throw new SizeMismatchError(entry.logicalName, entry.declaredSize, storedSize);
    }

    await trx
      .updateTable('aliquot.run_artifact')
      .set({
        artifact_id: existing.id,
        verification_state: 'VERIFIED',
        verified_at: sql<Date>`clock_timestamp()`,
        rejection_reason: null,
      })
      .where('id', '=', entry.id)
      .execute();

    const appended = await this.audit.append(trx, ctx, {
      action: 'artifact.deduplicated',
      targetType: 'run_artifact',
      targetId: entry.id,
      payload: {
        runId,
        logicalName: entry.logicalName,
        digest: entry.declaredDigest,
        artifactId: existing.id,
        sizeBytes: existing.size_bytes,
      },
    });

    return this.presentResult(entry, existing.id, appended.seq);
  }

  private async openOrResumeSession(
    trx: Trx,
    ctx: RequestContext,
    runId: string,
    entry: ManifestEntry,
  ): Promise<PreparedUpload> {
    let auditSeq: string | null = null;
    let session = await this.openSession(trx, ctx, entry.id);

    if (!session) {
      const plan = planParts(entry.declaredSize, this.config.storage.partSizeBytes);
      const storageKey = storageKeyForDigest(entry.declaredDigest);

      // A network call to the object store while holding the row lock taken in
      // loadEntry. It is one round trip and it belongs inside the transaction:
      // creating the multipart upload first and inserting afterwards would
      // orphan an upload in the store every time the insert lost the race on
      // `upload_session_one_open_per_artifact`, and those orphans are invisible
      // until somebody reads a storage bill.
      const storageUploadId = await this.store.createMultipartUpload(
        storageKey,
        entry.declaredMediaType,
      );

      const id = uuidv7();
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

      await trx
        .insertInto('aliquot.upload_session')
        .values({
          id,
          tenant_id: ctx.tenantId,
          run_artifact_id: entry.id,
          storage_key: storageKey,
          storage_upload_id: storageUploadId,
          part_size: plan.partSize,
          total_parts: plan.totalParts,
          expires_at: expiresAt,
        })
        .execute();

      await trx
        .updateTable('aliquot.run_artifact')
        .set({ verification_state: 'UPLOADING' })
        .where('id', '=', entry.id)
        .execute();

      const appended = await this.audit.append(trx, ctx, {
        action: 'upload.started',
        targetType: 'upload_session',
        targetId: id,
        payload: {
          runId,
          logicalName: entry.logicalName,
          digest: entry.declaredDigest,
          declaredSize: entry.declaredSize.toString(),
          partSize: plan.partSize.toString(),
          totalParts: plan.totalParts,
        },
      });
      auditSeq = appended.seq;

      session = { id, storageKey, storageUploadId, plan, expiresAt };
    }

    const completed = await trx
      .selectFrom('aliquot.upload_part')
      .select('part_number')
      .where('tenant_id', '=', ctx.tenantId)
      .where('upload_session_id', '=', session.id)
      .orderBy('part_number')
      .execute();

    return {
      alreadyPresent: false,
      entry,
      session,
      completedParts: completed.map((part) => part.part_number),
      auditSeq,
    };
  }

  /**
   * Signing happens after the transaction has committed.
   *
   * It is local HMAC work with no network in it, but there can be five hundred
   * of them, and holding the `run_artifact` row lock across that would block
   * every other caller touching the same manifest entry for no benefit.
   */
  private async signOutstandingParts(prepared: PreparedUpload): Promise<UploadSessionResult> {
    const { entry, session } = prepared;
    const done = new Set(prepared.completedParts);

    const outstanding: number[] = [];
    for (let partNumber = 1; partNumber <= session.plan.totalParts; partNumber += 1) {
      if (!done.has(partNumber)) outstanding.push(partNumber);
    }

    const parts = await Promise.all(
      outstanding.slice(0, MAX_PRESIGNED_PARTS).map(async (partNumber): Promise<PresignedPart> => {
        const span = partSpan(session.plan, entry.declaredSize, partNumber);
        const url = await this.store.presignUploadPart(
          session.storageKey,
          session.storageUploadId,
          partNumber,
        );
        return {
          partNumber,
          url,
          offset: span.offset.toString(),
          sizeBytes: span.sizeBytes.toString(),
        };
      }),
    );

    return {
      alreadyPresent: false,
      sessionId: session.id,
      runArtifactId: entry.id,
      logicalName: entry.logicalName,
      storageKey: session.storageKey,
      partSize: session.plan.partSize.toString(),
      totalParts: session.plan.totalParts,
      completedParts: [...done].sort((a, b) => a - b),
      outstandingParts: outstanding.length,
      parts,
      expiresAt: session.expiresAt,
      auditSeq: prepared.auditSeq,
    };
  }

  private async openSession(
    trx: Trx,
    ctx: RequestContext,
    runArtifactId: string,
  ): Promise<OpenSession | null> {
    const row = await trx
      .selectFrom('aliquot.upload_session')
      .select(['id', 'storage_key', 'storage_upload_id', 'part_size', 'total_parts', 'expires_at'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('run_artifact_id', '=', runArtifactId)
      .where('state', '=', 'OPEN')
      .executeTakeFirst();

    if (!row) return null;

    return {
      id: row.id,
      storageKey: row.storage_key,
      storageUploadId: row.storage_upload_id,
      plan: { partSize: BigInt(row.part_size), totalParts: row.total_parts },
      expiresAt: row.expires_at,
    };
  }

  /**
   * Ask the store to assemble the parts.
   *
   * A failure here is not a verification failure. Nothing has been proved wrong
   * about the data; the store simply would not put it together. So the session
   * is closed, the run stays OPEN, and the client can start a clean multipart
   * upload. Quarantining on an infrastructure error would strand a perfectly
   * good run in a terminal state over somebody else's outage.
   */
  private async finishMultipart(
    ctx: RequestContext,
    session: OpenSession,
    parts: CompletedPart[],
  ): Promise<void> {
    try {
      await this.store.completeMultipartUpload(session.storageKey, session.storageUploadId, parts);
      return;
    } catch (error) {
      // Completion may already have happened -- a client whose request timed out
      // after the store had committed, or two callers racing the same session.
      // The object existing is the only evidence that settles it.
      const existing = await this.store.headObject(session.storageKey);
      if (existing) return;

      // The store's own message is logged rather than returned: it quotes an
      // endpoint, a bucket and sometimes a credential id, none of which the
      // caller needs and all of which describe our deployment.
      this.logger.error('multipart completion failed', {
        sessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      });

      await this.store.abortMultipartUpload(session.storageKey, session.storageUploadId);
      await this.database.withTenant(ctx, async (trx) => {
        await trx
          .updateTable('aliquot.upload_session')
          .set({ state: 'ABORTED' })
          .where('id', '=', session.id)
          .execute();
      });

      throw new ConflictError(
        'The object store refused to assemble this upload. The session has been closed; ' +
          'start a new one and resend the parts.',
        { sessionId: session.id },
      );
    }
  }

  private async bindVerified(
    ctx: RequestContext,
    runId: string,
    logicalName: string,
    session: OpenSession,
    storedSize: bigint,
  ): Promise<CompleteResult> {
    return this.database.withTenant(ctx, async (trx) => {
      const { run, entry } = await this.loadEntry(trx, ctx, runId, logicalName);

      const bound = entry.artifactId;
      if (entry.verificationState === 'VERIFIED' && bound !== null) {
        return this.completedResult(entry, bound, true, null);
      }
      if (run.state !== 'OPEN') {
        // The bytes are stored and they are correct, so nothing is lost. The run
        // moved on while we were hashing and its manifest is frozen.
        throw new RunNotOpenError(runId, run.state);
      }

      const mintedId = uuidv7();
      await trx
        .insertInto('aliquot.artifact')
        .values({
          id: mintedId,
          tenant_id: ctx.tenantId,
          digest: entry.declaredDigest,
          size_bytes: storedSize,
          storage_key: session.storageKey,
          media_type: entry.declaredMediaType,
          first_seen_run_id: runId,
        })
        // Two runs uploading identical content at the same time is ordinary, not
        // exceptional. Absorbing the conflict and reading the winner back means
        // neither caller fails and both end up bound to the same row.
        .onConflict((oc) => oc.columns(['tenant_id', 'digest']).doNothing())
        .execute();

      const artifact = await trx
        .selectFrom('aliquot.artifact')
        .select('id')
        .where('tenant_id', '=', ctx.tenantId)
        .where('digest', '=', entry.declaredDigest)
        .executeTakeFirst();

      if (!artifact) {
        throw new Error(`artifact ${entry.declaredDigest} is absent immediately after insert`);
      }

      await trx
        .updateTable('aliquot.run_artifact')
        .set({
          artifact_id: artifact.id,
          verification_state: 'VERIFIED',
          verified_at: sql<Date>`clock_timestamp()`,
          rejection_reason: null,
        })
        .where('id', '=', entry.id)
        .execute();

      await trx
        .updateTable('aliquot.upload_session')
        .set({ state: 'COMPLETED', completed_at: sql<Date>`clock_timestamp()` })
        .where('id', '=', session.id)
        .execute();

      const appended = await this.audit.append(trx, ctx, {
        action: 'artifact.verified',
        targetType: 'run_artifact',
        targetId: entry.id,
        payload: {
          runId,
          logicalName,
          digest: entry.declaredDigest,
          sizeBytes: storedSize.toString(),
          artifactId: artifact.id,
          storageKey: session.storageKey,
          // Named in the payload so the audit trail records *how* the claim was
          // established, not merely that somebody asserted it.
          verifiedBy: 'read-back-sha256',
        },
      });

      return this.completedResult(entry, artifact.id, artifact.id !== mintedId, appended.seq);
    });
  }

  /**
   * Reject the artifact and quarantine the run, in one transaction.
   *
   * `RunService.quarantine` does both halves when it is given the logical name,
   * in the order `enforce_run_artifact_immutability` forces: manifest bindings
   * may only be touched while the run is OPEN, so the entry has to be marked
   * REJECTED before the run leaves that state.
   *
   * It runs before the `artifact.rejected` append rather than after, so that
   * locks are taken in the same order on every path: row locks first, then the
   * tenant's audit chain head. `bindVerified` takes them in that order too, and
   * reversing them on one path would deadlock a verification that succeeds
   * against one that fails.
   */
  private async reject(
    ctx: RequestContext,
    runId: string,
    entry: ManifestEntry,
    session: OpenSession,
    failure: { reason: string; detail: Record<string, unknown> },
  ): Promise<void> {
    await this.database.withTenant(ctx, async (trx) => {
      const quarantined = await this.runs.quarantine(
        trx,
        ctx,
        runId,
        failure.reason,
        // Named, so RunService marks the manifest entry REJECTED itself and does
        // it before the run leaves OPEN. Marking it here as well would be a
        // second implementation of an ordering constraint that is only correct
        // one way round.
        entry.logicalName,
      );

      await trx
        .updateTable('aliquot.upload_session')
        .set({ state: 'ABORTED' })
        .where('id', '=', session.id)
        .execute();

      // A null sequence number means the run was already quarantined for this
      // artifact and nothing was written -- the same completion arriving twice.
      // A second rejection event would record one fault as though it were two.
      if (quarantined.auditSeq === null) return;

      await this.audit.append(trx, ctx, {
        action: 'artifact.rejected',
        targetType: 'run_artifact',
        targetId: entry.id,
        payload: {
          runId,
          logicalName: entry.logicalName,
          declaredDigest: entry.declaredDigest,
          declaredSize: entry.declaredSize.toString(),
          reason: failure.reason,
          ...failure.detail,
        },
      });
    });

    // Belt and braces. By the time a digest is known to be wrong the multipart
    // upload has usually already completed, so there is no upload left to abort
    // and the store says so; the adapter treats that as success. It does real
    // work on the paths where completion never happened.
    await this.store.abortMultipartUpload(session.storageKey, session.storageUploadId);
  }

  private presentResult(
    entry: ManifestEntry,
    artifactId: string,
    auditSeq: string | null,
  ): AlreadyPresentResult {
    return {
      alreadyPresent: true,
      runArtifactId: entry.id,
      artifactId,
      logicalName: entry.logicalName,
      digest: entry.declaredDigest,
      sizeBytes: entry.declaredSize.toString(),
      auditSeq,
    };
  }

  private completedResult(
    entry: ManifestEntry,
    artifactId: string,
    deduplicated: boolean,
    auditSeq: string | null,
  ): CompleteResult {
    return {
      runArtifactId: entry.id,
      artifactId,
      logicalName: entry.logicalName,
      digest: entry.declaredDigest,
      sizeBytes: entry.declaredSize.toString(),
      deduplicated,
      auditSeq,
    };
  }

  private async loadArtifact(ctx: RequestContext, artifactId: string): Promise<ArtifactView> {
    return this.database.withTenant(ctx, async (trx) => {
      const artifact = await trx
        .selectFrom('aliquot.artifact')
        .select(['id', 'digest', 'size_bytes', 'media_type', 'first_seen_run_id', 'created_at'])
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', artifactId)
        .executeTakeFirst();

      if (!artifact) throw new NotFoundError('artifact', artifactId);

      // An artifact reaches a study by one of two routes, and both have to be
      // considered here. An uploaded artifact is bound by a manifest entry. A
      // *derived* artifact never appears in `run_artifact` at all -- it is a
      // processor output, recorded in `derivation_output` and tied to a study
      // through the derivation's source run.
      //
      // Reading only the first route makes every derived artifact belong to no
      // study, which the authorisation check below then reports as a 403 for
      // everyone including a tenant admin. The lineage endpoints get this right
      // by walking derivations, so the symptom is that an artifact is visible
      // in the provenance graph and cannot be fetched or downloaded.
      const [manifestBindings, derivedBindings] = await Promise.all([
        trx
          .selectFrom('aliquot.run_artifact as ra')
          .innerJoin('aliquot.run as r', 'r.id', 'ra.run_id')
          .select(['ra.run_id', 'ra.logical_name', 'r.study_id', 'ra.created_at'])
          .where('ra.tenant_id', '=', ctx.tenantId)
          .where('ra.artifact_id', '=', artifactId)
          .execute(),
        trx
          .selectFrom('aliquot.derivation_output as do')
          .innerJoin('aliquot.derivation as d', 'd.id', 'do.derivation_id')
          .innerJoin('aliquot.run as r', 'r.id', 'd.source_run_id')
          .select(['d.source_run_id as run_id', 'do.logical_name', 'r.study_id', 'd.started_at'])
          .where('do.tenant_id', '=', ctx.tenantId)
          .where('do.artifact_id', '=', artifactId)
          .execute(),
      ]);

      const boundTo = [
        ...manifestBindings.map((binding) => ({
          runId: binding.run_id,
          logicalName: binding.logical_name,
          studyId: binding.study_id,
          at: binding.created_at,
        })),
        ...derivedBindings.flatMap((binding) =>
          // source_run_id is nullable: a derivation not attributable to a single
          // run has no study to authorise against through this route.
          binding.run_id === null
            ? []
            : [
                {
                  runId: binding.run_id,
                  logicalName: binding.logical_name,
                  studyId: binding.study_id,
                  at: binding.started_at,
                },
              ],
        ),
      ].sort((left, right) => left.at.getTime() - right.at.getTime());

      return {
        id: artifact.id,
        digest: artifact.digest,
        sizeBytes: artifact.size_bytes,
        mediaType: artifact.media_type,
        firstSeenRunId: artifact.first_seen_run_id,
        createdAt: artifact.created_at,
        boundTo: boundTo.map(({ runId, logicalName, studyId }) => ({
          runId,
          logicalName,
          studyId,
        })),
      };
    });
  }

  /**
   * An artifact is reachable from every study whose runs bind it, and roles are
   * granted per study. Holding the role in any one of them is sufficient,
   * because it is literally the same bytes in all of them -- refusing on the
   * grounds that the artifact is *also* used by a study the caller cannot see
   * would deny them data they already hold through their own run.
   *
   * Row-level security has already confined this to the caller's tenant, so the
   * loop can only ever range over studies of that tenant.
   */
  private async requireAnyStudyRole(
    ctx: RequestContext,
    view: ArtifactView,
    roles: StudyRole[],
  ): Promise<void> {
    for (const studyId of new Set(view.boundTo.map((binding) => binding.studyId))) {
      try {
        await this.auth.requireStudyRole(ctx, studyId, roles);
        return;
      } catch (error) {
        // Only "you do not hold this role here" and "this study is not visible
        // to you" are worth trying the next study for. Anything else is a real
        // failure and must not be laundered into a 403.
        if (!(error instanceof AliquotError) || (error.status !== 403 && error.status !== 404)) {
          throw error;
        }
      }
    }

    throw new ForbiddenError(
      `Artifact ${view.id} is not reachable from any study you hold a role in.`,
      roles.join(' | '),
    );
  }
}

/**
 * The last path segment of a logical name, which is what a scientist expects to
 * find in their downloads folder. Falls back to the digest when the artifact is
 * bound to no manifest entry the caller can see.
 */
function downloadNameFor(view: ArtifactView): string {
  const first = view.boundTo[0];
  if (!first) return `${view.digest}.bin`;

  const segments = first.logicalName.split('/');
  return segments[segments.length - 1] ?? `${view.digest}.bin`;
}

/**
 * Decide which parts completion should quote.
 *
 * A client that recorded every part as it went does not have to repeat itself;
 * one that did not may send the list inline, and an inline entry wins over a
 * recorded one because it is the more recent statement. Either way the set must
 * cover 1..totalParts exactly, and an incomplete set is refused *before* the
 * store is asked to assemble anything.
 *
 * That refusal is a 409, not a rejection-and-quarantine, and the distinction is
 * deliberate: nothing has been stored, so nothing has been proved wrong about
 * the data -- the client simply has not finished. Quarantining a run for an
 * interrupted transfer would make resumption, the feature this entire flow
 * exists for, terminal.
 */
function resolveParts(
  provided: CompletedPart[],
  recorded: { part_number: number; etag: string }[],
  session: OpenSession,
  logicalName: string,
): CompletedPart[] {
  const byNumber = new Map<number, string>();
  for (const part of recorded) {
    byNumber.set(part.part_number, unquote(part.etag));
  }
  for (const part of provided) {
    byNumber.set(part.partNumber, unquote(part.etag));
  }

  const missing: number[] = [];
  const parts: CompletedPart[] = [];
  for (let partNumber = 1; partNumber <= session.plan.totalParts; partNumber += 1) {
    const etag = byNumber.get(partNumber);
    if (etag === undefined || etag.length === 0) {
      missing.push(partNumber);
    } else {
      parts.push({ partNumber, etag });
    }
  }

  if (missing.length > 0) {
    throw new ConflictError(
      `Artifact ${logicalName} is missing ${missing.length} of ${session.plan.totalParts} part(s).`,
      { logicalName, totalParts: session.plan.totalParts, missingParts: missing.slice(0, 50) },
    );
  }

  return parts;
}

function unquote(etag: string): string {
  return etag.replace(/^"|"$/g, '').trim();
}
