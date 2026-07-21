/**
 * Seed a demo dataset that could have been produced legitimately.
 *
 * The script has two halves and the split is deliberate.
 *
 * The first half connects as the database owner (DATABASE_ADMIN_URL) and creates
 * only what a tenant cannot create for itself: the tenant row, its first user,
 * its first study, and the admin membership that ties the two together.
 * `AuthService.requireTenantAdmin` says so in as many words -- administrative
 * standing is read as "you administer at least one study here", so a fresh
 * tenant has nobody the API would accept, and bootstrapping one is an
 * out-of-band operation by construction.
 *
 * Everything after that goes over HTTP against API_BASE_URL. That is the
 * interesting half and it is over HTTP on purpose: a seed that wrote runs,
 * manifests and artifacts straight into the database would produce a dataset no
 * instrument agent could have produced -- no idempotency records, no read-back
 * verification, no audit chain, no processing jobs -- and it would keep working
 * after the API stopped. Driving the real endpoints means the seed exercises the
 * same idempotency, verification and sealing paths a lab does, so a broken API
 * fails the seed instead of quietly populating a database the API disagrees
 * with.
 *
 * Nothing here imports from `src/`. The runtime image ships `dist/` and
 * `scripts/`, not `src/`, so an import that worked on a developer's machine
 * would fail inside the container -- and the one thing the seed genuinely needs
 * from the identity module, a working instrument key, it gets by asking
 * `POST /v1/instruments` for one, which is the same code path an administrator
 * uses.
 *
 * Re-running is safe. The tenant slug is the marker: if `acme` is present the
 * dataset is already there, and the script prints the summary and exits 0
 * without writing anything except a rotated instrument key, because a plaintext
 * key is shown exactly once and a summary that cannot be used is not a summary.
 */

import { createHash, randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { z } from 'zod';

const API_BASE_URL = (process.env.API_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

/** Long enough for a cold JIT and a first-request connection pool; short of a hang. */
const READY_TIMEOUT_MS = 60_000;
/** Sealing enqueues in the same transaction, so this is worker latency, not dispatch latency. */
const PROCESSING_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 500;

const PRIMARY_TENANT = 'acme';

interface TenantPlan {
  slug: string;
  name: string;
  study: { slug: string; title: string; description: string };
  /** The one user that has to exist before the API will talk to this tenant at all. */
  admin: { email: string; displayName: string };
}

const ACME: TenantPlan = {
  slug: PRIMARY_TENANT,
  name: 'Acme Biosciences',
  study: {
    slug: 'lightsheet-2026',
    title: 'Light-sheet imaging of organoid morphogenesis, 2026',
    description: 'Two-channel light-sheet acquisitions with per-plate flat-field calibration.',
  },
  admin: { email: 'mara.okafor@acme.test', displayName: 'Mara Okafor' },
};

/**
 * A second tenant with its own study, its own instrument and its own runs.
 *
 * It exists so that isolation is something a reviewer can see rather than read
 * about: the same `GET /v1/runs` under the two tokens returns two disjoint sets,
 * and the reason is a row-level security policy rather than a `where` clause
 * anybody could forget.
 */
const NORTHWIND: TenantPlan = {
  slug: 'northwind',
  name: 'Northwind Structural Biology',
  study: {
    slug: 'cryoem-pilot',
    title: 'Cryo-EM pilot: ribosome assembly intermediates',
    description: 'Single-particle collection pilot. Present so tenant isolation is visible.',
  },
  admin: { email: 'ines.duarte@northwind.test', displayName: 'Ines Duarte' },
};

interface BootstrappedTenant {
  plan: TenantPlan;
  tenantId: string;
  studyId: string;
  adminUserId: string;
  adminToken: string;
}

interface SeededUser {
  id: string;
  email: string;
  displayName: string;
  role: 'operator' | 'scientist' | 'steward' | 'admin';
}

interface SeededInstrument {
  id: string;
  slug: string;
}

async function main(): Promise<void> {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) {
    throw new Error('DATABASE_ADMIN_URL is required (the owner connection used for bootstrap)');
  }

  await waitForApi();

  const client = new Client({ connectionString: adminUrl });
  await client.connect();

  try {
    if (await tenantExists(client, PRIMARY_TENANT)) {
      console.log(`tenant ${PRIMARY_TENANT} is already seeded; nothing to do`);
      await printSummary(client, await rotateEveryInstrumentKey(client));
      return;
    }

    const acme = await bootstrapTenant(client, ACME);
    const northwind = await bootstrapTenant(client, NORTHWIND);

    const keys = new Map<string, string>();

    const acmeSealed = await seedAcme(acme, keys);
    const northwindSealed = await seedNorthwind(northwind, keys);

    // Before the summary, and bounded. The compose CI job asserts that a
    // PROCESSED run exists the moment the seed exits; returning while the worker
    // is still mid-job would make that assertion a race that passes on a fast
    // machine and fails on a loaded one. Each tenant is waited on under its own
    // credential, because a token from one tenant cannot see the other's runs --
    // which is the isolation the second tenant is here to demonstrate.
    await waitForProcessing(acme.adminToken, acmeSealed);
    await waitForProcessing(northwind.adminToken, northwindSealed);

    await printSummary(client, keys);
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Bootstrap: the rows a tenant cannot create for itself
// ---------------------------------------------------------------------------

async function tenantExists(client: Client, slug: string): Promise<boolean> {
  const result = await client.query('select 1 from aliquot.tenant where slug = $1', [slug]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Tenant, first user, first study, admin membership -- in one transaction.
 *
 * `randomUUID` and not a UUIDv7 helper: these four rows are identity objects
 * that nothing pages in creation order, so the property ADR-0011 exists for does
 * not apply to them, and copying the generator out of `src/common/uuid.ts` to
 * get it would be a second implementation of a load-bearing function. Every id
 * minted from here on comes from the service and is a v7.
 */
async function bootstrapTenant(client: Client, plan: TenantPlan): Promise<BootstrappedTenant> {
  const tenantId = randomUUID();
  const studyId = randomUUID();
  const adminUserId = randomUUID();

  await client.query('begin');
  try {
    await client.query('insert into aliquot.tenant (id, slug, name) values ($1, $2, $3)', [
      tenantId,
      plan.slug,
      plan.name,
    ]);

    await client.query(
      `insert into aliquot.app_user (id, tenant_id, email, display_name)
       values ($1, $2, $3, $4)`,
      [adminUserId, tenantId, plan.admin.email, plan.admin.displayName],
    );

    await client.query(
      `insert into aliquot.study (id, tenant_id, slug, title, description)
       values ($1, $2, $3, $4, $5)`,
      [studyId, tenantId, plan.study.slug, plan.study.title, plan.study.description],
    );

    await client.query(
      `insert into aliquot.membership (id, tenant_id, study_id, user_id, role)
       values ($1, $2, $3, $4, 'admin')`,
      [randomUUID(), tenantId, studyId, adminUserId],
    );

    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }

  console.log(`bootstrapped tenant ${plan.slug} with study ${plan.study.slug}`);

  return {
    plan,
    tenantId,
    studyId,
    adminUserId,
    adminToken: await issueToken(plan.admin.email, plan.slug),
  };
}

// ---------------------------------------------------------------------------
// The dataset
// ---------------------------------------------------------------------------

/**
 * Acme: four users, two instruments, six runs spanning the lifecycle.
 *
 * Returns the runs that were sealed, so the caller can wait for the worker.
 */
async function seedAcme(tenant: BootstrappedTenant, keys: Map<string, string>): Promise<string[]> {
  const users = await grantUsers(tenant, [
    { email: 'dana.reyes@acme.test', displayName: 'Dana Reyes', role: 'operator' },
    { email: 'sam.iyer@acme.test', displayName: 'Sam Iyer', role: 'scientist' },
    { email: 'priya.venkat@acme.test', displayName: 'Priya Venkat', role: 'steward' },
  ]);

  const operator = users.operator;
  const operatorToken = await issueToken(operator.email, tenant.plan.slug);

  const lightsheet = await registerInstrument(tenant, keys, {
    slug: 'ls-01',
    displayName: 'Light-sheet 01',
    manufacturer: 'Acme Optics',
    model: 'LS-4000',
    serialNumber: 'LS4000-002917',
  });
  const confocal = await registerInstrument(tenant, keys, {
    slug: 'cf-02',
    displayName: 'Confocal 02',
    manufacturer: 'Acme Optics',
    model: 'CF-880',
    serialNumber: 'CF880-114006',
  });

  // The same bytes in two runs. One `artifact` row, two `run_artifact` rows: the
  // second run's upload never transfers anything, because the digest is already
  // held by this tenant (ADR-0003, ADR-0017).
  const flatField = tiff('calibration/flatfield-2026-02.tif', 0x5eed, 2048, 1536, 240_000);

  const sealed: string[] = [];

  // --- A complete run, start to finish.
  const plate01 = await registerRun(operatorToken, tenant.studyId, {
    label: 'plate-01',
    instrumentId: lightsheet.id,
    operatorId: operator.id,
    acquiredAt: '2026-02-11T08:42:00Z',
    protocol: { objective: '20x', channels: ['DAPI', 'GFP'], exposureMs: 40, binning: 1 },
    files: [
      png('ch0/plate-01-field-001.png', 0x1101, 1024, 768, 180_000),
      tiff('ch1/plate-01-field-001.tif', 0x1102, 2048, 1536, 300_000),
      csv('qc/plate-01-focus.csv', 0x1103, 900),
      flatField,
    ],
  });
  await uploadAll(operatorToken, plate01);
  await sealRun(operatorToken, plate01.runId, 'plate-01');
  sealed.push(plate01.runId);

  // --- A second run on the other instrument, sharing the calibration file.
  const plate02 = await registerRun(operatorToken, tenant.studyId, {
    label: 'plate-02',
    instrumentId: confocal.id,
    operatorId: operator.id,
    acquiredAt: '2026-02-11T13:05:00Z',
    protocol: { objective: '40x', channels: ['DAPI', 'mCherry'], exposureMs: 25, binning: 2 },
    files: [
      png('ch0/plate-02-field-001.png', 0x2201, 1024, 768, 190_000),
      csv('qc/plate-02-focus.csv', 0x2203, 1200),
      flatField,
    ],
  });
  await uploadAll(operatorToken, plate02);
  await sealRun(operatorToken, plate02.runId, 'plate-02');
  sealed.push(plate02.runId);

  // --- An acquisition still in progress: two of three artifacts transferred.
  const plate03 = await registerRun(operatorToken, tenant.studyId, {
    label: 'plate-03',
    instrumentId: lightsheet.id,
    operatorId: operator.id,
    acquiredAt: '2026-02-12T09:20:00Z',
    protocol: { objective: '20x', channels: ['DAPI', 'GFP'], exposureMs: 40, binning: 1 },
    files: [
      png('ch0/plate-03-field-001.png', 0x3301, 1024, 768, 175_000),
      tiff('ch1/plate-03-field-001.tif', 0x3302, 2048, 1536, 310_000),
      csv('qc/plate-03-focus.csv', 0x3303, 800),
    ],
  });
  await uploadAll(operatorToken, plate03, { stopAfter: 1 });
  console.log(`run plate-03 left OPEN with 1 of 3 artifacts uploaded (${plate03.runId})`);

  // --- A transfer that arrives corrupted, which quarantines the run.
  const plate04 = await registerRun(operatorToken, tenant.studyId, {
    label: 'plate-04',
    instrumentId: lightsheet.id,
    operatorId: operator.id,
    acquiredAt: '2026-02-12T14:47:00Z',
    protocol: { objective: '20x', channels: ['DAPI', 'GFP'], exposureMs: 40, binning: 1 },
    files: [png('ch0/plate-04-field-001.png', 0x4401, 1024, 768, 160_000)],
  });
  await uploadCorrupted(operatorToken, plate04);

  // --- The correction. Superseding, never editing: the quarantined run keeps
  //     saying what it said, and the link points backwards only (ADR-0010).
  const plate04Corrected = await supersedeRun(operatorToken, plate04.runId, {
    label: 'plate-04-corrected',
    reason: 'ch0 field 001 failed read-back verification; re-transferred from the acquisition PC',
    instrumentId: lightsheet.id,
    operatorId: operator.id,
    acquiredAt: '2026-02-12T14:47:00Z',
    protocol: { objective: '20x', channels: ['DAPI', 'GFP'], exposureMs: 40, binning: 1 },
    files: [png('ch0/plate-04-field-001.png', 0x4401, 1024, 768, 160_000)],
  });
  await uploadAll(operatorToken, plate04Corrected);
  await sealRun(operatorToken, plate04Corrected.runId, 'plate-04-corrected');
  sealed.push(plate04Corrected.runId);

  // --- A run the operator gave up on.
  const plate05 = await registerRun(operatorToken, tenant.studyId, {
    label: 'plate-05',
    instrumentId: confocal.id,
    operatorId: operator.id,
    acquiredAt: '2026-02-13T07:58:00Z',
    protocol: { objective: '40x', channels: ['DAPI'], exposureMs: 25, binning: 2 },
    files: [png('ch0/plate-05-field-001.png', 0x5501, 1024, 768, 150_000)],
  });
  await abandonRun(operatorToken, plate05.runId, 'stage collision; specimen lost');

  return sealed;
}

/** Northwind: one admin, one instrument, one complete run. Enough to be visibly separate. */
async function seedNorthwind(
  tenant: BootstrappedTenant,
  keys: Map<string, string>,
): Promise<string[]> {
  const krios = await registerInstrument(tenant, keys, {
    slug: 'krios-01',
    displayName: 'Krios 01',
    manufacturer: 'Northwind Instruments',
    model: 'K3-300',
    serialNumber: 'K3-300-000411',
  });

  const grid01 = await registerRun(tenant.adminToken, tenant.studyId, {
    label: 'grid-01',
    instrumentId: krios.id,
    operatorId: tenant.adminUserId,
    acquiredAt: '2026-02-10T22:14:00Z',
    protocol: { magnification: 105000, defocusUm: -1.2, dosePerFrame: 1.1 },
    files: [
      tiff('micrographs/grid-01-0001.tif', 0x9901, 4096, 4096, 320_000),
      csv('qc/grid-01-ctf.csv', 0x9902, 600),
    ],
  });

  await uploadAll(tenant.adminToken, grid01);
  await sealRun(tenant.adminToken, grid01.runId, 'grid-01');

  return [grid01.runId];
}

// ---------------------------------------------------------------------------
// Identity, over HTTP
// ---------------------------------------------------------------------------

const membershipSchema = z.object({
  userId: z.string(),
  role: z.enum(['operator', 'scientist', 'steward', 'admin']),
  userCreated: z.boolean(),
});

/**
 * Grant the three non-admin roles, naming each member by email.
 *
 * The endpoint creates the user when the email is unknown, which is the only
 * user-creation path in the service and therefore the one worth exercising: a
 * membership and the person it refers to are written in one transaction, so
 * there is no state in which a user exists with no reason to.
 */
async function grantUsers(
  tenant: BootstrappedTenant,
  members: { email: string; displayName: string; role: SeededUser['role'] }[],
): Promise<Record<SeededUser['role'], SeededUser>> {
  const granted: Partial<Record<SeededUser['role'], SeededUser>> = {
    admin: {
      id: tenant.adminUserId,
      email: tenant.plan.admin.email,
      displayName: tenant.plan.admin.displayName,
      role: 'admin',
    },
  };

  for (const member of members) {
    const response = await api('POST', `/v1/studies/${tenant.studyId}/members`, {
      auth: tenant.adminToken,
      body: member,
    });
    const grant = membershipSchema.parse(expect(response, [201], `grant ${member.role}`));

    granted[member.role] = {
      id: grant.userId,
      email: member.email,
      displayName: member.displayName,
      role: member.role,
    };
  }

  const complete = granted as Record<SeededUser['role'], SeededUser>;
  for (const role of ['operator', 'scientist', 'steward', 'admin'] as const) {
    if (complete[role] === undefined) throw new Error(`no ${role} was granted`);
  }

  console.log(`granted ${members.length + 1} memberships on ${tenant.plan.study.slug}`);
  return complete;
}

const instrumentSchema = z.object({
  id: z.string(),
  slug: z.string(),
  displayName: z.string(),
  apiKey: z.string(),
  apiKeyPrefix: z.string(),
});

/**
 * Register an instrument and grant it deposit rights on the study.
 *
 * The plaintext key comes back from this call and from nowhere else -- only a
 * scrypt hash is stored -- which is exactly why the seed asks for it here rather
 * than writing an `instrument` row itself. A hash written by any other route
 * would be a credential produced by a code path production never takes.
 */
async function registerInstrument(
  tenant: BootstrappedTenant,
  keys: Map<string, string>,
  input: {
    slug: string;
    displayName: string;
    manufacturer: string;
    model: string;
    serialNumber: string;
  },
): Promise<SeededInstrument> {
  const registered = instrumentSchema.parse(
    expect(
      await api('POST', '/v1/instruments', { auth: tenant.adminToken, body: input }),
      [201],
      `register instrument ${input.slug}`,
    ),
  );

  expect(
    await api('POST', `/v1/studies/${tenant.studyId}/instruments`, {
      auth: tenant.adminToken,
      body: { instrumentId: registered.id },
    }),
    [200, 201],
    `grant instrument ${input.slug} to study`,
  );

  // The plaintext key is held for the summary and nowhere else. It is never
  // written back to the database and never logged in the ordinary output.
  keys.set(registered.id, registered.apiKey);
  console.log(`registered instrument ${input.slug} (${registered.apiKeyPrefix}...)`);

  return { id: registered.id, slug: registered.slug };
}

const rotatedKeySchema = z.object({ instrumentId: z.string(), apiKey: z.string() });

/**
 * Mint a fresh key for every instrument, for the already-seeded path.
 *
 * A plaintext key is shown once and is unrecoverable afterwards, so a re-run has
 * two options: print a summary with a credential nobody can use, or rotate.
 * Rotation is the operation an administrator would perform for the same reason,
 * it is recorded in the audit chain like everything else, and it leaves the
 * summary usable.
 */
async function rotateEveryInstrumentKey(client: Client): Promise<Map<string, string>> {
  const instruments = await client.query<{
    id: string;
    slug: string;
    tenant_slug: string;
    email: string;
  }>(
    `select i.id, i.slug, t.slug as tenant_slug, u.email
       from aliquot.instrument i
       join aliquot.tenant t on t.id = i.tenant_id
       join aliquot.membership m on m.tenant_id = i.tenant_id and m.role = 'admin' and m.revoked_at is null
       join aliquot.app_user u on u.id = m.user_id
      where i.disabled_at is null
      order by t.slug, i.slug`,
  );

  const keys = new Map<string, string>();
  const seen = new Set<string>();

  for (const row of instruments.rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);

    const token = await issueToken(row.email, row.tenant_slug);
    const rotated = rotatedKeySchema.parse(
      expect(
        await api('POST', `/v1/instruments/${row.id}/keys`, { auth: token }),
        [200, 201],
        `rotate key for ${row.slug}`,
      ),
    );

    keys.set(rotated.instrumentId, rotated.apiKey);
  }

  return keys;
}

const tokenSchema = z.object({
  token: z.string(),
  expiresInSeconds: z.number(),
  user: z.object({ id: z.string(), email: z.string(), tenantId: z.string() }),
});

async function issueToken(email: string, tenantSlug: string): Promise<string> {
  const response = await api('POST', '/v1/auth/token', { body: { email, tenantSlug } });

  if (response.status === 404) {
    throw new Error(
      'POST /v1/auth/token is not enabled on this API. The seed signs in as a real user ' +
        'rather than forging a token, so it needs AUTH_DEV_TOKEN_ENDPOINT=true.',
    );
  }

  return tokenSchema.parse(expect(response, [200], `sign in as ${email}`)).token;
}

// ---------------------------------------------------------------------------
// The run lifecycle, over HTTP
// ---------------------------------------------------------------------------

interface RunPlan {
  label: string;
  instrumentId: string;
  operatorId: string;
  acquiredAt: string;
  protocol: Record<string, unknown>;
  files: SyntheticFile[];
}

interface RegisteredRun {
  runId: string;
  label: string;
  files: SyntheticFile[];
}

const runMutationSchema = z.object({
  run: z.object({ id: z.string(), state: z.string(), manifestDigest: z.string() }),
  auditSeq: z.string(),
});

const sealResultSchema = runMutationSchema.extend({ processingJobId: z.string().nullable() });

async function registerRun(token: string, studyId: string, plan: RunPlan): Promise<RegisteredRun> {
  const result = runMutationSchema.parse(
    expect(
      await api('POST', `/v1/studies/${studyId}/runs`, {
        auth: token,
        idempotencyKey: idempotencyKey(plan.label, 'register'),
        body: {
          instrumentId: plan.instrumentId,
          operatorId: plan.operatorId,
          acquiredAt: plan.acquiredAt,
          protocol: plan.protocol,
          manifest: plan.files.map(manifestEntry),
        },
      }),
      [201],
      `register run ${plan.label}`,
    ),
  );

  console.log(
    `registered run ${plan.label} (${result.run.id}) with ${plan.files.length} declared artifacts, audit seq ${result.auditSeq}`,
  );

  return { runId: result.run.id, label: plan.label, files: plan.files };
}

async function supersedeRun(
  token: string,
  predecessorRunId: string,
  plan: RunPlan & { reason: string },
): Promise<RegisteredRun> {
  const result = runMutationSchema.parse(
    expect(
      await api('POST', `/v1/runs/${predecessorRunId}/supersede`, {
        auth: token,
        idempotencyKey: idempotencyKey(plan.label, 'supersede'),
        body: {
          reason: plan.reason,
          instrumentId: plan.instrumentId,
          operatorId: plan.operatorId,
          acquiredAt: plan.acquiredAt,
          protocol: plan.protocol,
          manifest: plan.files.map(manifestEntry),
        },
      }),
      [201],
      `supersede run ${predecessorRunId}`,
    ),
  );

  console.log(`run ${plan.label} (${result.run.id}) supersedes ${predecessorRunId}`);
  return { runId: result.run.id, label: plan.label, files: plan.files };
}

async function sealRun(token: string, runId: string, label: string): Promise<void> {
  const result = sealResultSchema.parse(
    expect(
      await api('POST', `/v1/runs/${runId}/seal`, {
        auth: token,
        idempotencyKey: idempotencyKey(label, 'seal'),
        body: {},
      }),
      [200],
      `seal run ${label}`,
    ),
  );

  console.log(
    `sealed run ${label}, processing job ${result.processingJobId ?? 'already queued'}, audit seq ${result.auditSeq}`,
  );
}

async function abandonRun(token: string, runId: string, reason: string): Promise<void> {
  const result = runMutationSchema.parse(
    expect(
      await api('POST', `/v1/runs/${runId}/abandon`, { auth: token, body: { reason } }),
      [200],
      `abandon run ${runId}`,
    ),
  );

  console.log(`abandoned run ${runId} (${result.run.state}): ${reason}`);
}

const beginSchema = z.discriminatedUnion('alreadyPresent', [
  z.object({
    alreadyPresent: z.literal(true),
    artifactId: z.string(),
    digest: z.string(),
  }),
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
  deduplicated: z.boolean(),
  auditSeq: z.string().nullable(),
});

/**
 * Transfer every declared artifact of a run.
 *
 * `stopAfter` leaves the rest of the manifest untouched, which is how the seed
 * produces a run that is genuinely mid-acquisition rather than one doctored to
 * look like it.
 */
async function uploadAll(
  token: string,
  run: RegisteredRun,
  options: { stopAfter?: number } = {},
): Promise<void> {
  const files = options.stopAfter === undefined ? run.files : run.files.slice(0, options.stopAfter);

  for (const file of files) {
    const outcome = await uploadOne(token, run.runId, file);
    console.log(`  ${run.label}: ${file.logicalName} ${outcome}`);
  }
}

async function uploadOne(token: string, runId: string, file: SyntheticFile): Promise<string> {
  const path = `/v1/runs/${runId}/artifacts/${file.logicalName}`;

  const begun = beginSchema.parse(
    expect(
      await api('POST', `${path}/upload`, { auth: token }),
      [200],
      `begin ${file.logicalName}`,
    ),
  );

  if (begun.alreadyPresent) {
    // The tenant already holds these exact bytes, so there is nothing to send:
    // one artifact, a second binding. For a 40 GB reference stack this is the
    // difference between an upload and a row.
    return 'already present by digest, transfer skipped';
  }

  for (const part of begun.parts) {
    const offset = Number(part.offset);
    const slice = file.bytes.subarray(offset, offset + Number(part.sizeBytes));

    const put = await fetch(part.url, { method: 'PUT', body: slice });
    if (!put.ok) {
      throw new Error(
        `PUT of part ${part.partNumber} of ${file.logicalName} failed: ${put.status} ${await put.text()}`,
      );
    }

    const etag = put.headers.get('etag');
    if (etag === null) {
      throw new Error(`the object store returned no ETag for part ${part.partNumber}`);
    }

    // Recorded as it lands, which is what makes the transfer resumable: a client
    // that dies here resumes from the parts the service already knows about
    // rather than starting the object again.
    expect(
      await api('POST', `${path}/upload/parts`, {
        auth: token,
        body: {
          sessionId: begun.sessionId,
          partNumber: part.partNumber,
          etag,
          sizeBytes: slice.length,
        },
      }),
      [200],
      `record part ${part.partNumber} of ${file.logicalName}`,
    );
  }

  const completed = completeSchema.parse(
    expect(
      await api('POST', `${path}/upload/complete`, { auth: token, body: {} }),
      [200],
      `complete ${file.logicalName}`,
    ),
  );

  return `uploaded in ${begun.totalParts} part(s), verified as ${completed.digest.slice(0, 12)}...`;
}

/**
 * Declare one set of bytes and send another.
 *
 * Nothing about the upload is special: the run is registered with a manifest,
 * the transfer completes normally, and the service reads the stored object back
 * and hashes it. The digest does not match what was declared, so the artifact is
 * rejected and the run is quarantined -- which is the only way this dataset gets
 * a QUARANTINED run that means anything.
 */
async function uploadCorrupted(token: string, run: RegisteredRun): Promise<void> {
  const declared = run.files[0];
  if (declared === undefined) throw new Error('the corrupted run has no declared artifact');

  const path = `/v1/runs/${run.runId}/artifacts/${declared.logicalName}`;
  const begun = beginSchema.parse(
    expect(await api('POST', `${path}/upload`, { auth: token }), [200], 'begin corrupted upload'),
  );

  if (begun.alreadyPresent) {
    throw new Error('the corrupted artifact was deduplicated; its bytes were meant to be unique');
  }

  // The same length, so the size check passes and the failure is the digest
  // rather than a truncation the service would have caught a step earlier.
  const damaged = Buffer.from(declared.bytes);
  damaged[damaged.length - 1] = (damaged[damaged.length - 1] ?? 0) ^ 0xff;

  for (const part of begun.parts) {
    const offset = Number(part.offset);
    const slice = damaged.subarray(offset, offset + Number(part.sizeBytes));

    const put = await fetch(part.url, { method: 'PUT', body: slice });
    if (!put.ok) {
      throw new Error(`PUT of the corrupted part failed: ${put.status}`);
    }

    const etag = put.headers.get('etag');
    if (etag === null) {
      throw new Error(`the object store returned no ETag for part ${part.partNumber}`);
    }

    expect(
      await api('POST', `${path}/upload/parts`, {
        auth: token,
        body: {
          sessionId: begun.sessionId,
          partNumber: part.partNumber,
          etag,
          sizeBytes: slice.length,
        },
      }),
      [200],
      `record corrupted part ${part.partNumber}`,
    );
  }

  const response = await api('POST', `${path}/upload/complete`, { auth: token, body: {} });
  if (response.status !== 422) {
    throw new Error(
      `expected 422 for a digest mismatch on ${declared.logicalName}, got ${response.status}: ` +
        render(response.body),
    );
  }

  console.log(
    `run ${run.label} (${run.runId}) quarantined: stored bytes did not match the declared digest`,
  );
}

const runDetailSchema = z.object({
  id: z.string(),
  state: z.string(),
  processingError: z.string().nullable(),
});

/**
 * Wait for the worker, or fail.
 *
 * Sealing and the job insert share a transaction, so a sealed run always has a
 * job. Anything other than PROCESSED within the timeout is therefore a real
 * fault -- a worker that is not running, a processor that threw -- and the seed
 * says which rather than exiting 0 with a half-populated database.
 */
async function waitForProcessing(token: string, runIds: string[]): Promise<void> {
  const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
  const pending = new Set(runIds);

  while (pending.size > 0) {
    for (const runId of [...pending]) {
      const detail = runDetailSchema.parse(
        expect(await api('GET', `/v1/runs/${runId}`, { auth: token }), [200], `read run ${runId}`),
      );

      if (detail.state === 'PROCESSED') {
        pending.delete(runId);
      } else if (detail.state === 'PROCESSING_FAILED') {
        throw new Error(
          `run ${runId} failed processing: ${detail.processingError ?? 'no reason recorded'}`,
        );
      }
    }

    if (pending.size === 0) break;

    if (Date.now() > deadline) {
      throw new Error(
        `${pending.size} run(s) were still not PROCESSED after ${PROCESSING_TIMEOUT_MS / 1000}s: ` +
          `${[...pending].join(', ')}. Is the worker running?`,
      );
    }

    await sleep(POLL_INTERVAL_MS);
  }

  console.log(`${runIds.length} run(s) processed`);
}

// ---------------------------------------------------------------------------
// Synthetic artifacts
// ---------------------------------------------------------------------------

interface SyntheticFile {
  logicalName: string;
  mediaType: string;
  bytes: Buffer;
  digest: string;
}

function manifestEntry(file: SyntheticFile): Record<string, unknown> {
  return {
    logicalName: file.logicalName,
    digest: file.digest,
    // A decimal string, not a number. Sizes are bigints everywhere in this
    // service and the manifest digest is taken over one spelling of them.
    sizeBytes: String(file.bytes.length),
    mediaType: file.mediaType,
  };
}

/**
 * Deterministic filler.
 *
 * `randomBytes` would work and is wrong here: the deduplication case needs the
 * same logical file to hash to the same digest on every seed of every clone, and
 * a reviewer comparing two databases should see the same digests in both. An LCG
 * is not a random number generator worth defending -- it is a reproducible byte
 * pattern, which is all this needs.
 */
function filler(seed: number, length: number): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  let state = seed >>> 0 || 1;

  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[index] = (state >>> 24) & 0xff;
  }

  return bytes;
}

function finish(logicalName: string, mediaType: string, bytes: Buffer): SyntheticFile {
  return {
    logicalName,
    mediaType,
    bytes,
    digest: createHash('sha256').update(bytes).digest('hex'),
  };
}

/**
 * A real PNG signature and IHDR header followed by filler.
 *
 * It is not a decodable image and does not pretend to be: the chunk CRCs are
 * zero and the pixel data is noise. What matters is that `metadata-extract`
 * recognises the magic bytes and reads the dimensions out of the header, so the
 * derived `metadata.json` in the seeded dataset contains something a reviewer can
 * check against the numbers below.
 */
function png(
  logicalName: string,
  seed: number,
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
  ihdr.writeUInt8(8, 16); // bit depth
  ihdr.writeUInt8(2, 17); // colour type: truecolour
  ihdr.writeUInt8(0, 18); // compression
  ihdr.writeUInt8(0, 19); // filter
  ihdr.writeUInt8(0, 20); // interlace

  const data = filler(seed, payloadBytes);
  const idat = Buffer.alloc(8);
  idat.writeUInt32BE(data.length, 0);
  idat.write('IDAT', 4, 'latin1');

  const iend = Buffer.alloc(12);
  iend.write('IEND', 4, 'latin1');

  return finish(
    logicalName,
    'image/png',
    Buffer.concat([signature, ihdr, idat, data, Buffer.alloc(4), iend]),
  );
}

/**
 * A little-endian TIFF header with a one-directory IFD carrying the two
 * dimension tags, then filler.
 *
 * Same intent as `png()`: enough structure for the processor to recognise the
 * format and report width and height, and no claim to be a valid image beyond
 * that.
 */
function tiff(
  logicalName: string,
  seed: number,
  width: number,
  height: number,
  payloadBytes: number,
): SyntheticFile {
  const header = Buffer.alloc(38);
  header.write('II', 0, 'latin1');
  header.writeUInt16LE(42, 2);
  header.writeUInt32LE(8, 4); // first IFD begins immediately after the header

  header.writeUInt16LE(2, 8); // two directory entries

  header.writeUInt16LE(0x0100, 10); // ImageWidth
  header.writeUInt16LE(3, 12); // SHORT
  header.writeUInt32LE(1, 14);
  header.writeUInt16LE(width, 18);

  header.writeUInt16LE(0x0101, 22); // ImageLength
  header.writeUInt16LE(3, 24); // SHORT
  header.writeUInt32LE(1, 26);
  header.writeUInt16LE(height, 30);

  header.writeUInt32LE(0, 34); // no further IFD

  return finish(logicalName, 'image/tiff', Buffer.concat([header, filler(seed, payloadBytes)]));
}

/** Delimited text, which `metadata-extract` reports with a line and column count. */
function csv(logicalName: string, seed: number, rows: number): SyntheticFile {
  const lines: string[] = ['field,z_um,focus_score,intensity_mean,saturated_px'];
  let state = seed >>> 0 || 1;

  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };

  for (let row = 0; row < rows; row += 1) {
    lines.push(
      [
        String(row + 1).padStart(4, '0'),
        (next() * 120 - 60).toFixed(2),
        next().toFixed(4),
        (next() * 4095).toFixed(1),
        String(Math.floor(next() * 40)),
      ].join(','),
    );
  }

  return finish(logicalName, 'text/csv', Buffer.from(`${lines.join('\n')}\n`, 'utf8'));
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/**
 * Read the dataset back out of the database and print it.
 *
 * Read back rather than printed from what the seed happens to be holding,
 * because both paths through this script -- a fresh seed and a re-run over an
 * existing one -- need the same summary, and only one of them has the ids in
 * memory. It also means the summary describes what is actually stored.
 */
async function printSummary(client: Client, keys: Map<string, string>): Promise<void> {
  const tenants = await client.query<{ id: string; slug: string; name: string }>(
    'select id, slug, name from aliquot.tenant order by slug',
  );

  console.log('');
  console.log('='.repeat(78));
  console.log('Aliquot demo dataset');
  console.log('='.repeat(78));

  for (const tenant of tenants.rows) {
    const studies = await client.query<{ id: string; slug: string; title: string }>(
      'select id, slug, title from aliquot.study where tenant_id = $1 order by slug',
      [tenant.id],
    );
    const members = await client.query<{ id: string; email: string; role: string }>(
      `select u.id, u.email, m.role
         from aliquot.app_user u
         join aliquot.membership m on m.user_id = u.id and m.revoked_at is null
        where u.tenant_id = $1
        order by m.role, u.email`,
      [tenant.id],
    );
    const instruments = await client.query<{ id: string; slug: string; api_key_prefix: string }>(
      'select id, slug, api_key_prefix from aliquot.instrument where tenant_id = $1 order by slug',
      [tenant.id],
    );
    const runs = await client.query<{ id: string; state: string; acquired_at: Date | null }>(
      'select id, state, acquired_at from aliquot.run where tenant_id = $1 order by registered_at',
      [tenant.id],
    );
    const events = await client.query<{ count: string }>(
      'select count(*)::text as count from aliquot.audit_event where tenant_id = $1',
      [tenant.id],
    );

    const adminEmail = members.rows.find((member) => member.role === 'admin')?.email;

    console.log('');
    console.log(`tenant ${tenant.slug}  (${tenant.name})`);
    console.log(`  id            ${tenant.id}`);

    for (const study of studies.rows) {
      console.log(`  study         ${study.id}  ${study.slug}`);
    }
    for (const member of members.rows) {
      console.log(`  ${member.role.padEnd(13)} ${member.id}  ${member.email}`);
    }
    for (const instrument of instruments.rows) {
      const key = keys.get(instrument.id);
      console.log(`  instrument    ${instrument.id}  ${instrument.slug}`);
      console.log(`    api key     ${key ?? `${instrument.api_key_prefix}... (not shown again)`}`);
    }
    for (const run of runs.rows) {
      console.log(`  run           ${run.id}  ${run.state}`);
    }
    console.log(`  audit events  ${events.rows[0]?.count ?? '0'}`);

    if (adminEmail !== undefined) {
      const token = await issueToken(adminEmail, tenant.slug);
      console.log(`  token (${adminEmail})`);
      console.log(`    ${token}`);
    }
  }

  const acme = tenants.rows.find((tenant) => tenant.slug === PRIMARY_TENANT);
  const acmeAdmin = acme
    ? await client.query<{ email: string }>(
        `select u.email from aliquot.app_user u
           join aliquot.membership m on m.user_id = u.id and m.role = 'admin' and m.revoked_at is null
          where u.tenant_id = $1 limit 1`,
        [acme.id],
      )
    : undefined;
  const email = acmeAdmin?.rows[0]?.email;

  console.log('');
  console.log('-'.repeat(78));
  console.log('Tokens above expire; mint another with');
  console.log('');
  console.log(`  curl -s ${API_BASE_URL}/v1/auth/token \\`);
  console.log("    -H 'content-type: application/json' \\");
  console.log(`    -d '{"email":"${email ?? ACME.admin.email}","tenantSlug":"${PRIMARY_TENANT}"}'`);
  console.log('');
  console.log(`Viewer: ${API_BASE_URL}/   OpenAPI: ${API_BASE_URL}/docs`);
  console.log('-'.repeat(78));
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

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

/**
 * The body, or a failure that names the problem document.
 *
 * Every call site lists the statuses it expects, so an endpoint that starts
 * answering differently stops the seed at the step that changed rather than
 * three steps later on a missing field.
 */
function expect(response: ApiResponse, statuses: number[], what: string): unknown {
  if (!statuses.includes(response.status)) {
    throw new Error(
      `${what}: expected ${statuses.join(' or ')}, got ${response.status}\n  ${render(response.body)}`,
    );
  }
  return response.body;
}

function render(body: unknown): string {
  return typeof body === 'string' ? body : JSON.stringify(body);
}

/**
 * Deterministic, so a seed interrupted halfway and re-run against the same
 * database replays its earlier requests rather than duplicating them.
 */
function idempotencyKey(label: string, operation: string): string {
  return `seed-${label}-${operation}`;
}

async function waitForApi(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;

  for (;;) {
    try {
      const response = await fetch(`${API_BASE_URL}/readyz`);
      if (response.ok) return;
    } catch {
      // Connection refused while the API is still starting. Only the deadline
      // below distinguishes "not up yet" from "not coming up", so there is
      // nothing to report here that the timeout will not report better.
    }

    if (Date.now() > deadline) {
      throw new Error(
        `${API_BASE_URL}/readyz did not become ready within ${READY_TIMEOUT_MS / 1000}s`,
      );
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
