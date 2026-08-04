import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/**
 * Kysely's view of the schema in `migrations/`.
 *
 * Hand-written rather than generated. Generation is the obvious move and was
 * rejected for one reason: the generator's output is only as good as the moment
 * it ran, and a stale generated file that still compiles is worse than no file
 * at all -- it type-checks against a schema the database no longer has. Keeping
 * it hand-written makes drift a compile error the first time a query touches a
 * column that moved, and the integration suite runs the real migrations, so
 * anything this file gets wrong fails there rather than in production.
 */

/** Server-assigned on insert, never written by the application. */
type ServerTimestamp = ColumnType<Date, Date | string | undefined, never>;
/** Nullable, application-writable timestamp. */
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;

export type ActorType = 'user' | 'instrument' | 'system';

export type RunState =
  | 'OPEN'
  | 'SEALED'
  | 'PROCESSING'
  | 'PROCESSED'
  | 'PROCESSING_FAILED'
  | 'QUARANTINED'
  | 'ABANDONED';

export type StudyRole = 'operator' | 'scientist' | 'steward' | 'admin';

export type ArtifactVerificationState = 'DECLARED' | 'UPLOADING' | 'VERIFIED' | 'REJECTED';

export type UploadSessionState = 'OPEN' | 'COMPLETED' | 'ABORTED';

export type IdempotencyState = 'IN_FLIGHT' | 'COMPLETED';

export type JobState = 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'DEAD';

/**
 * Whether a tenant is part of the enduring record. See migration 0008: a
 * sandbox tenant is the only thing this service ever deletes, and this column
 * is what makes that a property of the schema rather than of a WHERE clause.
 */
export type TenantKind = 'permanent' | 'sandbox';

export interface TenantTable {
  id: string;
  slug: string;
  name: string;
  created_at: ServerTimestamp;
  /**
   * Neither column is application-writable. Rows are created by
   * `aliquot.provision_sandbox_tenant()` and removed by
   * `aliquot.reap_sandbox_tenant()`; `aliquot_app` holds SELECT on this table
   * and nothing else, so an insert or update from here is a permission error
   * rather than a decision.
   */
  kind: ColumnType<TenantKind, never, never>;
  expires_at: ColumnType<Date | null, never, never>;
}

export interface AppUserTable {
  id: string;
  tenant_id: string;
  email: string;
  display_name: string;
  created_at: ServerTimestamp;
  disabled_at: NullableTimestamp;
}

export interface InstrumentTable {
  id: string;
  tenant_id: string;
  slug: string;
  display_name: string;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  api_key_hash: string;
  api_key_prefix: string;
  created_at: ServerTimestamp;
  disabled_at: NullableTimestamp;
}

export interface StudyTable {
  id: string;
  tenant_id: string;
  slug: string;
  title: string;
  description: string | null;
  created_at: ServerTimestamp;
  closed_at: NullableTimestamp;
}

export interface MembershipTable {
  id: string;
  tenant_id: string;
  study_id: string;
  user_id: string;
  role: StudyRole;
  granted_at: ServerTimestamp;
  granted_by: string | null;
  revoked_at: NullableTimestamp;
}

export interface InstrumentStudyGrantTable {
  tenant_id: string;
  instrument_id: string;
  study_id: string;
  granted_at: ServerTimestamp;
  granted_by: string | null;
}

export interface ArtifactTable {
  id: string;
  tenant_id: string;
  digest: string;
  size_bytes: ColumnType<string, string | number | bigint, never>;
  storage_key: string;
  media_type: Generated<string>;
  first_seen_run_id: string;
  created_at: ServerTimestamp;
}

export interface RunTable {
  id: string;
  tenant_id: string;
  study_id: string;
  instrument_id: string;
  operator_id: string;
  state: Generated<RunState>;
  acquired_at: NullableTimestamp;
  registered_at: ServerTimestamp;
  sealed_at: NullableTimestamp;
  quarantined_at: NullableTimestamp;
  abandoned_at: NullableTimestamp;
  supersedes_run_id: string | null;
  supersede_reason: string | null;
  manifest_digest: string;
  protocol: Generated<Record<string, unknown>>;
  quarantine_reason: string | null;
  processing_attempts: Generated<number>;
  processing_started_at: NullableTimestamp;
  processing_completed_at: NullableTimestamp;
  processing_error: string | null;
}

export interface RunArtifactTable {
  id: string;
  tenant_id: string;
  run_id: string;
  logical_name: string;
  declared_digest: string;
  declared_size: ColumnType<string, string | number | bigint, never>;
  declared_media_type: Generated<string>;
  artifact_id: string | null;
  verification_state: Generated<ArtifactVerificationState>;
  verified_at: NullableTimestamp;
  rejection_reason: string | null;
  created_at: ServerTimestamp;
}

export interface UploadSessionTable {
  id: string;
  tenant_id: string;
  run_artifact_id: string;
  storage_key: string;
  storage_upload_id: string;
  part_size: ColumnType<string, string | number | bigint, never>;
  total_parts: number;
  state: Generated<UploadSessionState>;
  created_at: ServerTimestamp;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  completed_at: NullableTimestamp;
}

export interface UploadPartTable {
  tenant_id: string;
  upload_session_id: string;
  part_number: number;
  etag: string;
  size_bytes: ColumnType<string, string | number | bigint, string | number | bigint>;
  completed_at: ServerTimestamp;
}

export interface AuditEventTable {
  tenant_id: string;
  seq: ColumnType<string, string | number | bigint, never>;
  id: string;
  actor_type: ActorType;
  actor_id: string | null;
  actor_label: string;
  action: string;
  target_type: string;
  target_id: string | null;
  payload: Record<string, unknown>;
  payload_digest: string;
  prev_hash: string;
  hash: string;
  occurred_at: ColumnType<Date, never, never>;
  correlation_id: string | null;
}

export interface AuditCheckpointTable {
  id: string;
  tenant_id: string;
  through_seq: ColumnType<string, string | number | bigint, never>;
  chain_hash: string;
  event_count: ColumnType<string, string | number | bigint, never>;
  created_at: ServerTimestamp;
  external_ref: string | null;
}

export interface IdempotencyKeyTable {
  id: string;
  tenant_id: string;
  key: string;
  endpoint: string;
  request_fingerprint: string;
  state: Generated<IdempotencyState>;
  response_status: number | null;
  response_body: unknown;
  resource_id: string | null;
  created_at: ServerTimestamp;
  completed_at: NullableTimestamp;
  expires_at: ColumnType<Date, Date | string, Date | string>;
}

export interface DerivationTable {
  id: string;
  tenant_id: string;
  processor_name: string;
  processor_version: string;
  parameters: Generated<Record<string, unknown>>;
  parameters_digest: string;
  inputs_digest: string;
  started_at: ServerTimestamp;
  completed_at: NullableTimestamp;
  source_run_id: string | null;
}

export interface DerivationInputTable {
  tenant_id: string;
  derivation_id: string;
  artifact_id: string;
  role: Generated<string>;
}

export interface DerivationOutputTable {
  tenant_id: string;
  derivation_id: string;
  artifact_id: string;
  logical_name: string;
}

export interface JobTable {
  id: string;
  tenant_id: string;
  queue: string;
  payload: Generated<Record<string, unknown>>;
  state: Generated<JobState>;
  priority: Generated<number>;
  dedupe_key: string | null;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  run_after: ColumnType<Date, Date | string | undefined, Date | string>;
  lease_expires_at: NullableTimestamp;
  claimed_by: string | null;
  last_error: string | null;
  created_at: ServerTimestamp;
  started_at: NullableTimestamp;
  completed_at: NullableTimestamp;
}

export interface Database {
  'aliquot.tenant': TenantTable;
  'aliquot.app_user': AppUserTable;
  'aliquot.instrument': InstrumentTable;
  'aliquot.study': StudyTable;
  'aliquot.membership': MembershipTable;
  'aliquot.instrument_study_grant': InstrumentStudyGrantTable;
  'aliquot.artifact': ArtifactTable;
  'aliquot.run': RunTable;
  'aliquot.run_artifact': RunArtifactTable;
  'aliquot.upload_session': UploadSessionTable;
  'aliquot.upload_part': UploadPartTable;
  'aliquot.audit_event': AuditEventTable;
  'aliquot.audit_checkpoint': AuditCheckpointTable;
  'aliquot.idempotency_key': IdempotencyKeyTable;
  'aliquot.derivation': DerivationTable;
  'aliquot.derivation_input': DerivationInputTable;
  'aliquot.derivation_output': DerivationOutputTable;
  'aliquot.job': JobTable;
}

export type Run = Selectable<RunTable>;
export type NewRun = Insertable<RunTable>;
export type RunUpdate = Updateable<RunTable>;
export type RunArtifact = Selectable<RunArtifactTable>;
export type NewRunArtifact = Insertable<RunArtifactTable>;
export type Artifact = Selectable<ArtifactTable>;
export type NewArtifact = Insertable<ArtifactTable>;
export type AuditEvent = Selectable<AuditEventTable>;
export type Derivation = Selectable<DerivationTable>;
export type Job = Selectable<JobTable>;
export type Study = Selectable<StudyTable>;
export type AppUser = Selectable<AppUserTable>;
export type Instrument = Selectable<InstrumentTable>;
export type UploadSession = Selectable<UploadSessionTable>;
