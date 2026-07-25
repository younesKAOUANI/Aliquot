/**
 * A narrated walkthrough of the five guarantees, against a running stack.
 *
 * It is a demo and it is also a smoke test, and the second of those is what
 * makes the first worth watching: every step states what it expects and exits
 * non-zero when the service does something else. A walkthrough that narrates
 * success regardless of what came back is a slide deck with a shell prompt.
 *
 * Run `npm run seed` first. The demo deliberately does not create its own tenant
 * -- it signs in as the seeded users and adds one more run to the seeded study,
 * because half of what it demonstrates (deduplication against bytes that are
 * already held, a lineage that reaches a real instrument and a real operator)
 * only means anything against a dataset that was already there.
 *
 * It is safe to run repeatedly. Its run is registered under a fresh idempotency
 * key each time, its artifacts carry an invocation-unique digest, and the audit
 * event it tampers with in the last step is put back exactly as it was.
 *
 * Two connections, for two different reasons. Everything a client can do is done
 * over HTTP against API_BASE_URL. DATABASE_ADMIN_URL is used for the two things
 * no client can do: reading the seeded identity to sign in as it, and playing
 * the insider in step 9 -- disabling an append-only trigger and rewriting a
 * committed audit row is precisely the attack the chain exists to make visible,
 * and it cannot be staged through the API by design.
 */

import { createHash, randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { z } from 'zod';

const API_BASE_URL = (process.env.API_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

const TENANT_SLUG = 'acme';
const STUDY_SLUG = 'lightsheet-2026';
/** Seeded by `scripts/seed.ts` into two runs already. The demo makes it three. */
const SHARED_ARTIFACT = 'calibration/flatfield-2026-02.tif';

const PROCESSING_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 500;

/** Distinguishes this invocation's runs, artifacts and idempotency keys from the last one's. */
const INVOCATION = randomUUID().slice(0, 8);

interface Cast {
  tenantId: string;
  studyId: string;
  operator: { id: string; email: string; token: string };
  steward: { id: string; email: string; token: string };
}

async function main(): Promise<void> {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) {
    throw new Error('DATABASE_ADMIN_URL is required (the owner connection used for step 9)');
  }

  const client = new Client({ connectionString: adminUrl });
  await client.connect();

  try {
    const cast = await signIn(client);

    const registration = await step1Register(cast);
    await step2Replay(client, cast, registration);
    await step3Diverge(cast, registration);
    await step4Upload(cast, registration);
    const sealed = await step5Seal(client, cast, registration);
    const derived = await step6Process(cast, registration);
    await step7Lineage(cast, derived);
    await step8Verify(cast);
    await step9Tamper(client, cast, registration);

    heading('done');
    console.log(
      `  run ${registration.runId} is PROCESSED, sealed by audit event ${sealed.auditSeq},`,
    );
    console.log('  its lineage reaches the instrument and the operator, and the chain verifies.');
    console.log('');
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// 1. Register
// ---------------------------------------------------------------------------

interface Registration {
  runId: string;
  auditSeq: string;
  manifestDigest: string;
  /** Exactly what was sent, so step 2 can send it again byte for byte. */
  body: Record<string, unknown>;
  idempotencyKey: string;
  newArtifact: SyntheticFile;
  sharedArtifact: { logicalName: string; digest: string; sizeBytes: string; mediaType: string };
}

const runMutationSchema = z.object({
  run: z.object({ id: z.string(), state: z.string(), manifestDigest: z.string() }),
  auditSeq: z.string(),
});

async function step1Register(cast: Cast): Promise<Registration> {
  heading('1. Register a run');

  const shared = await findSharedArtifact(cast);
  const fresh = png(`ch0/demo-${INVOCATION}.png`, INVOCATION, 1024, 768, 220_000);

  const body: Record<string, unknown> = {
    instrumentId: await anyInstrument(cast),
    operatorId: cast.operator.id,
    acquiredAt: new Date().toISOString(),
    protocol: { objective: '20x', channels: ['DAPI', 'GFP'], exposureMs: 40 },
    manifest: [
      {
        logicalName: fresh.logicalName,
        digest: fresh.digest,
        sizeBytes: String(fresh.bytes.length),
        mediaType: fresh.mediaType,
      },
      shared,
    ],
  };

  const idempotencyKey = `demo-${INVOCATION}-register`;
  const result = runMutationSchema.parse(
    expect(
      await api('POST', `/v1/studies/${cast.studyId}/runs`, {
        auth: cast.operator.token,
        idempotencyKey,
        body,
      }),
      [201],
      'register the run',
    ),
  );

  console.log(`  run id          ${result.run.id}`);
  console.log(`  state           ${result.run.state}`);
  console.log(`  manifest digest ${result.run.manifestDigest}`);
  console.log(`  audit seq       ${result.auditSeq}`);
  console.log(`  idempotency key ${idempotencyKey}`);

  return {
    runId: result.run.id,
    auditSeq: result.auditSeq,
    manifestDigest: result.run.manifestDigest,
    body,
    idempotencyKey,
    newArtifact: fresh,
    sharedArtifact: shared,
  };
}

// ---------------------------------------------------------------------------
// 2. Replay
// ---------------------------------------------------------------------------

async function step2Replay(client: Client, cast: Cast, registration: Registration): Promise<void> {
  heading('2. Send the identical request again');

  const response = await api('POST', `/v1/studies/${cast.studyId}/runs`, {
    auth: cast.operator.token,
    idempotencyKey: registration.idempotencyKey,
    body: registration.body,
  });

  const replayed = runMutationSchema.parse(expect(response, [201], 'replay the registration'));

  // 201 and not 200. The stored status is replayed, so a retrying client cannot
  // tell which of its attempts was the one that did the work -- which is the
  // property, not an implementation detail of it.
  expectThat(response.status === 201, `replay answered ${response.status}, not the stored 201`);
  expectThat(
    replayed.run.id === registration.runId,
    `replay returned run ${replayed.run.id}, not ${registration.runId}`,
  );
  expectThat(
    replayed.auditSeq === registration.auditSeq,
    'the replay appended a second audit event',
  );

  const runs = await client.query<{ count: string }>(
    `select count(*)::text as count from aliquot.run
      where tenant_id = $1 and manifest_digest = $2`,
    [cast.tenantId, registration.manifestDigest],
  );
  const count = runs.rows[0]?.count ?? '0';

  console.log(`  status          201 (the stored status, replayed)`);
  console.log(`  run id          ${replayed.run.id}  identical`);
  console.log(`  audit seq       ${replayed.auditSeq}  no second event`);
  console.log(`  runs in the database with this manifest digest: ${count}`);

  expectThat(count === '1', `expected exactly one run, the database holds ${count}`);
}

// ---------------------------------------------------------------------------
// 3. The same key, a different request
// ---------------------------------------------------------------------------

const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string().optional(),
  idempotencyKey: z.string().optional(),
  endpoint: z.string().optional(),
});

async function step3Diverge(cast: Cast, registration: Registration): Promise<void> {
  heading('3. Reuse the key for a materially different request');

  const manifest = Array.isArray(registration.body.manifest) ? registration.body.manifest : [];
  const changed = {
    ...registration.body,
    protocol: { objective: '63x', channels: ['DAPI'], exposureMs: 90 },
    manifest,
  };

  const response = await api('POST', `/v1/studies/${cast.studyId}/runs`, {
    auth: cast.operator.token,
    idempotencyKey: registration.idempotencyKey,
    body: changed,
  });

  expectThat(response.status === 409, `expected 409, got ${response.status}`);
  const problem = problemSchema.parse(response.body);

  console.log(`  status          ${problem.status}`);
  console.log(`  type            ${problem.type}`);
  console.log(`  endpoint        ${problem.endpoint ?? '(absent)'}`);
  console.log(`  key             ${problem.idempotencyKey ?? '(absent)'}`);
  console.log(`  detail          ${problem.detail ?? '(absent)'}`);
  console.log('');
  console.log('  Answering with the stored response would be worse than an error here:');
  console.log('  it would look like the changed request had been accepted.');

  expectThat(
    problem.type.endsWith('/idempotency-key-reused'),
    `expected the idempotency-key-reused problem type, got ${problem.type}`,
  );
}

// ---------------------------------------------------------------------------
// 4. Upload
// ---------------------------------------------------------------------------

const beginSchema = z.discriminatedUnion('alreadyPresent', [
  z.object({ alreadyPresent: z.literal(true), artifactId: z.string(), digest: z.string() }),
  z.object({
    alreadyPresent: z.literal(false),
    sessionId: z.string(),
    totalParts: z.number(),
    parts: z.array(
      z.object({
        partNumber: z.number(),
        url: z.string(),
        offset: z.string(),
        sizeBytes: z.string(),
      }),
    ),
  }),
]);

const completeSchema = z.object({
  artifactId: z.string(),
  digest: z.string(),
  sizeBytes: z.string(),
  deduplicated: z.boolean(),
  auditSeq: z.string().nullable(),
});

async function step4Upload(cast: Cast, registration: Registration): Promise<void> {
  heading('4. Upload the declared artifacts');

  const file = registration.newArtifact;
  const path = `/v1/runs/${registration.runId}/artifacts/${file.logicalName}`;

  const begun = beginSchema.parse(
    expect(
      await api('POST', `${path}/upload`, { auth: cast.operator.token }),
      [200],
      `begin ${file.logicalName}`,
    ),
  );
  expectThat(!begun.alreadyPresent, 'the fresh artifact was already present, which cannot happen');
  if (begun.alreadyPresent) return;

  console.log(`  ${file.logicalName}`);
  console.log(`    ${begun.totalParts} part(s), presigned; the bytes never touch the API process`);

  for (const part of begun.parts) {
    const offset = Number(part.offset);
    const slice = file.bytes.subarray(offset, offset + Number(part.sizeBytes));

    const put = await fetch(part.url, { method: 'PUT', body: slice });
    expectThat(put.ok, `PUT of part ${part.partNumber} failed with ${put.status}`);

    const etag = put.headers.get('etag');
    expectThat(etag !== null, `the object store returned no ETag for part ${part.partNumber}`);

    expect(
      await api('POST', `${path}/upload/parts`, {
        auth: cast.operator.token,
        body: {
          sessionId: begun.sessionId,
          partNumber: part.partNumber,
          etag: etag ?? '',
          sizeBytes: slice.length,
        },
      }),
      [200],
      `record part ${part.partNumber}`,
    );
  }

  const completed = completeSchema.parse(
    expect(
      await api('POST', `${path}/upload/complete`, { auth: cast.operator.token, body: {} }),
      [200],
      `complete ${file.logicalName}`,
    ),
  );

  console.log(`    stored and read back: sha256 ${completed.digest}`);
  console.log(`    declared:             sha256 ${file.digest}`);
  console.log(`    audit seq            ${completed.auditSeq ?? '(none)'}`);
  expectThat(completed.digest === file.digest, 'the service accepted a digest it did not verify');

  // The second artifact is the calibration file the seeded runs already hold.
  const sharedPath = `/v1/runs/${registration.runId}/artifacts/${registration.sharedArtifact.logicalName}`;
  const shared = beginSchema.parse(
    expect(
      await api('POST', `${sharedPath}/upload`, { auth: cast.operator.token }),
      [200],
      `begin ${registration.sharedArtifact.logicalName}`,
    ),
  );

  console.log('');
  console.log(`  ${registration.sharedArtifact.logicalName}`);
  expectThat(
    shared.alreadyPresent,
    'the shared artifact was not recognised; deduplication did not happen',
  );
  if (!shared.alreadyPresent) return;

  console.log('    already present by digest: no session, no presigned URLs, no transfer');
  console.log(`    bound to artifact ${shared.artifactId}`);
  console.log(`    sha256 ${shared.digest}`);
}

// ---------------------------------------------------------------------------
// 5. Seal
// ---------------------------------------------------------------------------

const sealSchema = runMutationSchema.extend({ processingJobId: z.string().nullable() });

interface Sealed {
  auditSeq: string;
  processingJobId: string;
}

async function step5Seal(client: Client, cast: Cast, registration: Registration): Promise<Sealed> {
  heading('5. Seal the run');

  const sealed = sealSchema.parse(
    expect(
      await api('POST', `/v1/runs/${registration.runId}/seal`, {
        auth: cast.operator.token,
        idempotencyKey: `demo-${INVOCATION}-seal`,
        body: {},
      }),
      [200],
      'seal the run',
    ),
  );

  expectThat(sealed.run.state === 'SEALED', `the run is ${sealed.run.state}, not SEALED`);
  expectThat(sealed.processingJobId !== null, 'sealing enqueued no processing job');
  const jobId = sealed.processingJobId ?? '';

  const job = await client.query<{ id: string; queue: string; dedupe_key: string; state: string }>(
    'select id, queue, dedupe_key, state from aliquot.job where tenant_id = $1 and id = $2',
    [cast.tenantId, jobId],
  );
  const row = job.rows[0];
  expectThat(row !== undefined, `no job row ${jobId} exists`);

  const event = await client.query<{ seq: string; payload: { processingJobId?: string } }>(
    `select seq, payload from aliquot.audit_event
      where tenant_id = $1 and action = 'run.sealed' and target_id = $2`,
    [cast.tenantId, registration.runId],
  );
  const recorded = event.rows[0];
  expectThat(recorded !== undefined, 'no run.sealed audit event was appended');

  console.log(`  state           ${sealed.run.state}`);
  console.log(`  audit seq       ${sealed.auditSeq}`);
  console.log(`  job             ${jobId}  queue ${row?.queue ?? '?'}  state ${row?.state ?? '?'}`);
  console.log(`  dedupe key      ${row?.dedupe_key ?? '?'}`);
  console.log(`  run.sealed payload names job ${recorded?.payload.processingJobId ?? '(absent)'}`);
  console.log('');
  console.log('  The state change, the job row and the audit event are one commit. There is no');
  console.log('  window in which a run is sealed and nothing will ever process it.');

  expectThat(
    recorded?.payload.processingJobId === jobId,
    'the audit event names a different job than the response did',
  );

  return { auditSeq: sealed.auditSeq, processingJobId: jobId };
}

// ---------------------------------------------------------------------------
// 6. Processing
// ---------------------------------------------------------------------------

const derivationsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      processorName: z.string(),
      processorVersion: z.string(),
      parametersDigest: z.string(),
      inputsDigest: z.string(),
      completedAt: z.string().nullable(),
      inputs: z.array(z.object({ artifactId: z.string(), role: z.string() })),
      outputs: z.array(z.object({ artifactId: z.string(), logicalName: z.string() })),
    }),
  ),
});

const runDetailSchema = z.object({ state: z.string(), processingError: z.string().nullable() });

async function step6Process(cast: Cast, registration: Registration): Promise<string> {
  heading('6. Wait for the worker');

  const deadline = Date.now() + PROCESSING_TIMEOUT_MS;

  for (;;) {
    const detail = runDetailSchema.parse(
      expect(
        await api('GET', `/v1/runs/${registration.runId}`, { auth: cast.operator.token }),
        [200],
        'read the run',
      ),
    );

    if (detail.state === 'PROCESSED') break;
    expectThat(
      detail.state !== 'PROCESSING_FAILED',
      `processing failed: ${detail.processingError ?? 'no reason recorded'}`,
    );
    expectThat(Date.now() < deadline, 'the run was never processed; is the worker running?');

    await sleep(POLL_INTERVAL_MS);
  }

  const derivations = derivationsSchema.parse(
    expect(
      await api('GET', `/v1/runs/${registration.runId}/derivations`, { auth: cast.steward.token }),
      [200],
      'list derivations',
    ),
  );

  expectThat(derivations.items.length > 0, 'the run was processed but recorded no derivation');

  let metadataOutput: string | undefined;

  for (const derivation of derivations.items) {
    console.log(`  ${derivation.processorName} ${derivation.processorVersion}`);
    console.log(`    derivation    ${derivation.id}`);
    console.log(
      `    inputs        ${derivation.inputs.length} artifact(s), digest ${derivation.inputsDigest.slice(0, 16)}...`,
    );
    for (const output of derivation.outputs) {
      console.log(`    output        ${output.logicalName}  ${output.artifactId}`);
      if (derivation.processorName === 'metadata-extract') {
        metadataOutput = output.artifactId;
      }
    }
  }

  console.log('');
  console.log('  A derivation is identified by (inputs, processor, version, parameters), so');
  console.log('  re-running identical work cannot record a second one.');

  expectThat(metadataOutput !== undefined, 'metadata-extract produced no output');
  return metadataOutput ?? '';
}

// ---------------------------------------------------------------------------
// 7. Lineage
// ---------------------------------------------------------------------------

const lineageSchema = z.object({
  artifactId: z.string(),
  truncated: z.boolean(),
  nodes: z.array(z.object({ kind: z.string(), label: z.string() })),
  edges: z.array(z.object({ type: z.string() })),
  roots: z.array(
    z.object({
      artifactId: z.string(),
      logicalName: z.string().nullable(),
      run: z.object({ id: z.string(), state: z.string() }).nullable(),
      instrument: z.object({ slug: z.string(), displayName: z.string() }).nullable(),
      operator: z.object({ id: z.string(), displayName: z.string() }).nullable(),
      processors: z.array(z.object({ name: z.string(), version: z.string() })),
    }),
  ),
});

async function step7Lineage(cast: Cast, derivedArtifactId: string): Promise<void> {
  heading('7. Walk the lineage of a derived artifact');

  const graph = lineageSchema.parse(
    expect(
      await api('GET', `/v1/artifacts/${derivedArtifactId}/lineage?direction=ancestors`, {
        auth: cast.steward.token,
      }),
      [200],
      'trace lineage',
    ),
  );

  console.log(`  artifact        ${graph.artifactId}`);
  console.log(
    `  graph           ${graph.nodes.length} nodes, ${graph.edges.length} edges, truncated=${graph.truncated}`,
  );
  console.log('');

  expectThat(graph.roots.length > 0, 'the lineage has no root; ancestry stopped nowhere');

  for (const root of graph.roots) {
    console.log(`  root            ${root.logicalName ?? root.artifactId}`);
    console.log(`    run           ${root.run?.id ?? '(none)'}  ${root.run?.state ?? ''}`);
    console.log(
      `    instrument    ${root.instrument?.displayName ?? '(none)'} (${root.instrument?.slug ?? '-'})`,
    );
    console.log(`    operator      ${root.operator?.displayName ?? '(none)'}`);
    console.log(
      `    processors    ${root.processors.map((p) => `${p.name} ${p.version}`).join(', ')}`,
    );
  }

  const attributed = graph.roots.filter(
    (root) => root.run !== null && root.instrument !== null && root.operator !== null,
  );
  expectThat(
    attributed.length === graph.roots.length,
    'a root artifact could not be attributed to a run, an instrument and an operator',
  );

  console.log('');
  console.log('  Nobody typed any of this. It is a traversal of the rows the ingestion and');
  console.log('  processing paths wrote as a side effect of doing their work.');
  console.log(
    `  The same graph as W3C PROV-JSON: GET /v1/artifacts/${derivedArtifactId}/lineage.prov.json`,
  );
}

// ---------------------------------------------------------------------------
// 8. Verify
// ---------------------------------------------------------------------------

const verifySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), eventsVerified: z.number(), headHash: z.string() }),
  z.object({
    ok: z.literal(false),
    brokenAtSeq: z.string(),
    reason: z.string(),
    expected: z.string(),
    actual: z.string(),
  }),
]);

type Verification = z.infer<typeof verifySchema>;

async function verifyChain(cast: Cast): Promise<Verification> {
  return verifySchema.parse(
    expect(
      await api('POST', '/v1/audit/verify', {
        auth: cast.steward.token,
        body: { studyId: cast.studyId },
      }),
      [200],
      'verify the audit chain',
    ),
  );
}

async function step8Verify(cast: Cast): Promise<void> {
  heading('8. Verify the audit chain');

  const result = await verifyChain(cast);
  expectThat(result.ok, 'the chain was already broken before the demo tampered with it');
  if (!result.ok) return;

  console.log(`  ok              true`);
  console.log(`  events verified ${result.eventsVerified}`);
  console.log(`  head hash       ${result.headHash}`);
  console.log('');
  console.log('  Every event is hashed over (tenant, seq, prev_hash, payload_digest, occurred_at)');
  console.log('  by the database, not by the application. The verifier recomputes all of it.');
}

// ---------------------------------------------------------------------------
// 9. Tamper, and put it back
// ---------------------------------------------------------------------------

async function step9Tamper(client: Client, cast: Cast, registration: Registration): Promise<void> {
  heading('9. Rewrite a committed audit event as the database owner');

  const target = await client.query<{ seq: string; payload: Record<string, unknown> }>(
    `select seq, payload from aliquot.audit_event
      where tenant_id = $1 and action = 'run.registered' and target_id = $2`,
    [cast.tenantId, registration.runId],
  );
  const event = target.rows[0];
  expectThat(event !== undefined, 'the registration event is missing from the chain');
  if (event === undefined) return;

  const original = event.payload;
  const forged = { ...original, manifestDigest: '0'.repeat(64) };

  console.log(`  target          seq ${event.seq}, the run.registered event from step 1`);
  console.log(`  manifestDigest  ${String(original.manifestDigest)}`);
  console.log(`  rewritten to    ${'0'.repeat(64)}`);
  console.log('');
  console.log('  The application role cannot do this: UPDATE is revoked and an append-only');
  console.log('  trigger rejects it. So the demo connects as the owner and switches the');
  console.log('  trigger off, which is the strongest insider this design admits to.');

  await writeEventPayload(client, cast.tenantId, event.seq, forged);

  const broken = await verifyChain(cast);
  expectThat(!broken.ok, 'the chain still verified after an event was rewritten');
  if (broken.ok) return;

  console.log('');
  console.log(`  ok              false`);
  console.log(`  broken at seq   ${broken.brokenAtSeq}`);
  console.log(`  reason          ${broken.reason}`);
  console.log(`  expected        ${broken.expected}`);
  console.log(`  actual          ${broken.actual}`);

  expectThat(
    broken.brokenAtSeq === event.seq,
    `verification blamed seq ${broken.brokenAtSeq}, the edit was at ${event.seq}`,
  );
  expectThat(
    broken.reason === 'payload_digest',
    `expected a payload_digest divergence, got ${broken.reason}`,
  );

  await writeEventPayload(client, cast.tenantId, event.seq, original);

  const restored = await verifyChain(cast);
  expectThat(restored.ok, 'the chain did not verify after the payload was restored');
  if (!restored.ok) return;

  console.log('');
  console.log(
    `  payload restored; ok ${String(restored.ok)}, ${restored.eventsVerified} events, head ${restored.headHash.slice(0, 16)}...`,
  );
  console.log('');
  console.log('  Detection, not prevention. An owner who also recomputed every hash after');
  console.log(
    '  seq ' + event.seq + ' would produce a chain that verifies -- which is why checkpoints',
  );
  console.log('  are meant to be mirrored somewhere the database role cannot reach.');
}

/**
 * Disable the trigger, write, re-enable -- in one transaction.
 *
 * The transaction is not decoration. `ALTER TABLE ... DISABLE TRIGGER` is
 * transactional in PostgreSQL, so a failure between the disable and the
 * re-enable rolls the protection back rather than leaving the audit table
 * writable because a demo crashed halfway.
 */
async function writeEventPayload(
  client: Client,
  tenantId: string,
  seq: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query('begin');
  try {
    await client.query('alter table aliquot.audit_event disable trigger audit_event_no_update');
    const updated = await client.query(
      'update aliquot.audit_event set payload = $3::jsonb where tenant_id = $1 and seq = $2',
      [tenantId, seq, JSON.stringify(payload)],
    );
    await client.query('alter table aliquot.audit_event enable trigger audit_event_no_update');
    await client.query('commit');

    expectThat(
      updated.rowCount === 1,
      `expected to rewrite one row, rewrote ${updated.rowCount ?? 0}`,
    );
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Cast and fixtures
// ---------------------------------------------------------------------------

/**
 * Find the seeded tenant and sign in as two of its people.
 *
 * The operator produces data and the steward reviews it. Both roles are used
 * where they belong rather than doing everything as an administrator, because an
 * administrator satisfies every check and a demo driven entirely by one proves
 * nothing about the authorisation model.
 */
async function signIn(client: Client): Promise<Cast> {
  const tenant = await client.query<{ id: string }>(
    'select id from aliquot.tenant where slug = $1',
    [TENANT_SLUG],
  );
  const tenantId = tenant.rows[0]?.id;
  if (tenantId === undefined) {
    throw new Error(`tenant ${TENANT_SLUG} does not exist. Run \`npm run seed\` first.`);
  }

  const study = await client.query<{ id: string }>(
    'select id from aliquot.study where tenant_id = $1 and slug = $2',
    [tenantId, STUDY_SLUG],
  );
  const studyId = study.rows[0]?.id;
  if (studyId === undefined) {
    throw new Error(`study ${STUDY_SLUG} does not exist. Run \`npm run seed\` first.`);
  }

  const people = await client.query<{ id: string; email: string; role: string }>(
    `select u.id, u.email, m.role
       from aliquot.app_user u
       join aliquot.membership m on m.user_id = u.id and m.revoked_at is null
      where u.tenant_id = $1 and m.study_id = $2`,
    [tenantId, studyId],
  );

  const operator = people.rows.find((person) => person.role === 'operator');
  const steward = people.rows.find((person) => person.role === 'steward');
  if (operator === undefined || steward === undefined) {
    throw new Error(
      `study ${STUDY_SLUG} has no operator or no steward. Run \`npm run seed\` first.`,
    );
  }

  return {
    tenantId,
    studyId,
    operator: { id: operator.id, email: operator.email, token: await issueToken(operator.email) },
    steward: { id: steward.id, email: steward.email, token: await issueToken(steward.email) },
  };
}

const tokenSchema = z.object({ token: z.string() });

async function issueToken(email: string): Promise<string> {
  const response = await api('POST', '/v1/auth/token', {
    body: { email, tenantSlug: TENANT_SLUG },
  });

  if (response.status === 404) {
    throw new Error(
      'POST /v1/auth/token is not enabled on this API. The demo signs in as the seeded ' +
        'users rather than forging tokens, so it needs AUTH_DEV_TOKEN_ENDPOINT=true.',
    );
  }

  return tokenSchema.parse(expect(response, [200], `sign in as ${email}`)).token;
}

const runSearchSchema = z.object({
  items: z.array(z.object({ id: z.string(), instrumentId: z.string() })),
});

/** Any instrument already depositing into the study; the demo does not register its own. */
async function anyInstrument(cast: Cast): Promise<string> {
  const page = runSearchSchema.parse(
    expect(
      await api('GET', `/v1/runs?studyId=${cast.studyId}&limit=1`, { auth: cast.operator.token }),
      [200],
      'search runs',
    ),
  );

  const instrumentId = page.items[0]?.instrumentId;
  if (instrumentId === undefined) {
    throw new Error(`study ${STUDY_SLUG} has no runs to take an instrument from. Run the seed.`);
  }
  return instrumentId;
}

const manifestSchema = z.object({
  manifest: z.array(
    z.object({
      logicalName: z.string(),
      declaredDigest: z.string(),
      declaredSize: z.string(),
      declaredMediaType: z.string(),
      verificationState: z.string(),
    }),
  ),
});

/**
 * The calibration file the seeded runs share, declared verbatim.
 *
 * Read out of a seeded run rather than recomputed here: declaring the digest of
 * bytes this script generated would only demonstrate that the same function
 * produces the same output. Taking it from a run that already uploaded it is the
 * real case -- a file the instrument sends with every acquisition, which the
 * tenant already holds.
 */
async function findSharedArtifact(
  cast: Cast,
): Promise<{ logicalName: string; digest: string; sizeBytes: string; mediaType: string }> {
  const page = runSearchSchema.parse(
    expect(
      await api('GET', `/v1/runs?studyId=${cast.studyId}&limit=50`, { auth: cast.operator.token }),
      [200],
      'search runs',
    ),
  );

  for (const run of page.items) {
    const detail = manifestSchema.parse(
      expect(
        await api('GET', `/v1/runs/${run.id}`, { auth: cast.operator.token }),
        [200],
        `read run ${run.id}`,
      ),
    );

    const entry = detail.manifest.find(
      (candidate) =>
        candidate.logicalName === SHARED_ARTIFACT && candidate.verificationState === 'VERIFIED',
    );

    if (entry !== undefined) {
      return {
        logicalName: entry.logicalName,
        digest: entry.declaredDigest,
        sizeBytes: entry.declaredSize,
        mediaType: entry.declaredMediaType,
      };
    }
  }

  throw new Error(`no seeded run holds a verified ${SHARED_ARTIFACT}. Run \`npm run seed\` first.`);
}

interface SyntheticFile {
  logicalName: string;
  mediaType: string;
  bytes: Buffer;
  digest: string;
}

/** A real PNG signature and IHDR header over filler bytes; see scripts/seed.ts. */
function png(
  logicalName: string,
  seed: string,
  width: number,
  height: number,
  payloadBytes: number,
): SyntheticFile {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16);
  ihdr.writeUInt8(2, 17);

  // Seeded from the invocation id, so two runs of the demo declare two different
  // digests and the upload in step 4 is a real transfer rather than a
  // deduplication of the previous run's bytes.
  const data = Buffer.alloc(payloadBytes);
  let block = createHash('sha256').update(seed).digest();
  for (let offset = 0; offset < payloadBytes; offset += block.length) {
    block.copy(data, offset, 0, Math.min(block.length, payloadBytes - offset));
    block = createHash('sha256').update(block).digest();
  }

  const idat = Buffer.alloc(8);
  idat.writeUInt32BE(data.length, 0);
  idat.write('IDAT', 4, 'latin1');

  const iend = Buffer.alloc(12);
  iend.write('IEND', 4, 'latin1');

  const bytes = Buffer.concat([signature, ihdr, idat, data, Buffer.alloc(4), iend]);

  return {
    logicalName,
    mediaType: 'image/png',
    bytes,
    digest: createHash('sha256').update(bytes).digest('hex'),
  };
}

// ---------------------------------------------------------------------------
// Narration and HTTP
// ---------------------------------------------------------------------------

function heading(title: string): void {
  console.log('');
  console.log(`-- ${title} ${'-'.repeat(Math.max(0, 74 - title.length))}`);
}

/** Any deviation from the narration stops the demo, because the narration is the assertion. */
function expectThat(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

interface ApiResponse {
  status: number;
  body: unknown;
}

interface RequestOptions {
  auth?: string;
  idempotencyKey?: string;
  body?: unknown;
}

async function api(
  method: 'GET' | 'POST',
  path: string,
  options: RequestOptions = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  if (options.auth !== undefined) headers.authorization = `Bearer ${options.auth}`;
  if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  const body: unknown =
    text.length > 0 && contentType.includes('json') ? (JSON.parse(text) as unknown) : text;

  return { status: response.status, body };
}

function expect(response: ApiResponse, statuses: number[], what: string): unknown {
  if (!statuses.includes(response.status)) {
    const rendered =
      typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
    throw new Error(
      `${what}: expected ${statuses.join(' or ')}, got ${response.status}\n  ${rendered}`,
    );
  }
  return response.body;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  console.error('');
  console.error(`demo failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
