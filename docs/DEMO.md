# Demo walkthrough

A run through the whole arc by hand, with `curl`: register an acquisition, prove
the registration is exactly-once, upload artifacts and have the service verify
them, seal, watch the worker derive something, walk the lineage back to the
instrument and the operator, verify the audit chain, break it, and watch
verification name the row that changed.

`scripts/demo.ts` does all of this automatically and fails the process on any
deviation (`npm run demo`). This document is the version you read, and the one to
use when you want to see the actual request and response shapes.

Responses below are abridged — fields that are always `null` on a fresh run are
dropped — and every id, sequence number and chain hash will differ on your
machine. *Artifact* digests will not: the sample artifact and the seeded ones are
generated deterministically, so the `sha256` you compute is the one printed here.

---

## 0. Bring it up

```bash
docker compose up            # postgres, minio, migrations, api, worker, seed
```

The seed creates two tenants, four users on the imaging study, three instruments
and seven runs spanning the lifecycle, and waits for the worker to finish before
exiting. Its final block prints the ids, an instrument API key and a session
token for each tenant.

Everything below assumes:

```bash
BASE=http://localhost:3000
```

`jq` is used for readability only; a text editor works as well.

---

## 1. Sign in

`POST /v1/auth/token` exists only when `AUTH_DEV_TOKEN_ENDPOINT=true`, which
compose sets. A real deployment federates to an OIDC provider and this route is
absent — not forbidden, absent.

The seeded study has one user per role. Which one you use matters, so keep all
four:

```bash
for who in dana.reyes sam.iyer priya.venkat mara.okafor; do
  curl -s -X POST "$BASE/v1/auth/token" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$who@acme.test\",\"tenantSlug\":\"acme\"}" | jq -r .token
done
```

```bash
OPERATOR=...   # dana.reyes    registers runs, uploads, seals
SCIENTIST=...  # sam.iyer      reads lineage and derivations
STEWARD=...    # priya.venkat  verifies and checkpoints the audit chain
ADMIN=...      # mara.okafor   instruments, studies, members
```

```jsonc
// POST /v1/auth/token
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "tokenType": "Bearer",
  "expiresInSeconds": 3600,
  "user": {
    "id": "019fbedd-d1c6-7000-9854-cb66edef71d6",
    "email": "dana.reyes@acme.test",
    "displayName": "Dana Reyes",
    "tenantId": "529a7580-5c6f-4d98-8292-f999758d360d",
    "tenantSlug": "acme"
  },
  "auditSeq": "68"
}
```

Signing in is itself an audited event, which is why it has a sequence number.

---

## 2. Find the study, and an instrument to attribute the run to

```bash
curl -s "$BASE/v1/studies" -H "authorization: Bearer $OPERATOR" | jq '.items[0]'
```

```jsonc
{
  "id": "8e5b69bc-e70c-4984-b04b-f486c3583b6d",
  "slug": "lightsheet-2026",
  "title": "Light-sheet imaging of organoid morphogenesis, 2026",
  "closedAt": null,
  "role": "operator"          // the caller's standing, not a property of the study
}
```

```bash
STUDY=8e5b69bc-e70c-4984-b04b-f486c3583b6d

curl -s "$BASE/v1/runs?studyId=$STUDY&limit=1" -H "authorization: Bearer $OPERATOR" \
  | jq '.items[0] | {id, state, instrumentId, operatorId}'
```

Take `instrumentId` for the next step, and note `nextCursor` in the full
response: collections are cursor-paged, never offset-paged.

---

## 3. Make an artifact and hash it

```bash
printf 'field,z_um,focus_score\n' > /tmp/walkthrough.csv
for i in $(seq 1 500); do
  printf '%04d,%s,0.%03d\n' "$i" "$((i % 60))" "$((i % 997))"
done >> /tmp/walkthrough.csv

sha256sum /tmp/walkthrough.csv   # 906ff0b0576bdbae214a326a7244c4c583e10da916e3298bc92eead9bcbf2f2a
wc -c < /tmp/walkthrough.csv     # 6934
```

The digest is the producer's declaration. The service will read the stored object
back and compute its own.

Also find the digest of a file the tenant *already* holds — the seeded
calibration image, which two runs share — so that step 6 can show what happens
when there is nothing to transfer:

```bash
for id in $(curl -s "$BASE/v1/runs?studyId=$STUDY&limit=50" \
              -H "authorization: Bearer $OPERATOR" | jq -r '.items[].id'); do
  curl -s "$BASE/v1/runs/$id" -H "authorization: Bearer $OPERATOR" \
    | jq '.manifest[] | select(.logicalName == "calibration/flatfield-2026-02.tif")'
done | head -8
```

```jsonc
{
  "logicalName": "calibration/flatfield-2026-02.tif",
  "declaredDigest": "37f91d8674561a9129bfce686f354720499df7b308536ad65a4ed85c6514dec1",
  "declaredSize": "240038",
  "declaredMediaType": "image/tiff",
  "verificationState": "VERIFIED"
}
```

---

## 4. Register the run

`Idempotency-Key` is required, not optional. The clients are instrument agents
that retry on any timeout, including the timeouts where the request succeeded.

```bash
KEY="walkthrough-$(date +%s)"

cat > /tmp/register.json <<JSON
{
  "instrumentId": "019fbedd-d286-7000-bb72-7d3ebf38206b",
  "operatorId":   "019fbedd-d1c6-7000-9854-cb66edef71d6",
  "acquiredAt":   "2026-03-04T11:00:00Z",
  "protocol":     { "objective": "20x", "channels": ["DAPI"] },
  "manifest": [
    { "logicalName": "qc/walkthrough.csv",
      "digest":      "906ff0b0576bdbae214a326a7244c4c583e10da916e3298bc92eead9bcbf2f2a",
      "sizeBytes":   "6934",
      "mediaType":   "text/csv" },
    { "logicalName": "calibration/flatfield-2026-02.tif",
      "digest":      "37f91d8674561a9129bfce686f354720499df7b308536ad65a4ed85c6514dec1",
      "sizeBytes":   "240038",
      "mediaType":   "image/tiff" }
  ]
}
JSON

curl -s -X POST "$BASE/v1/studies/$STUDY/runs" \
  -H "authorization: Bearer $OPERATOR" \
  -H 'content-type: application/json' \
  -H "idempotency-key: $KEY" \
  -d @/tmp/register.json | jq .
```

`201 Created`:

```jsonc
{
  "run": {
    "id": "019fbede-71e7-7000-ae3a-6b5c6efc2fb1",
    "state": "OPEN",
    "studyId": "8e5b69bc-e70c-4984-b04b-f486c3583b6d",
    "instrumentId": "019fbedd-d286-7000-bb72-7d3ebf38206b",
    "operatorId": "019fbedd-d1c6-7000-9854-cb66edef71d6",
    "acquiredAt": "2026-03-04T11:00:00.000Z",
    "registeredAt": "2026-08-01T19:47:57.032Z",
    "manifestDigest": "0f7329dd169b084640b3a8fe2f5516ac9a13f0a390ada6a013d6f32ec61d0feb"
  },
  "auditSeq": "69"
}
```

```bash
RUN=019fbede-71e7-7000-ae3a-6b5c6efc2fb1
```

`auditSeq` is on every mutation: the caller can confirm its own write landed in
the chain without polling the audit stream. `manifestDigest` is fixed here and
re-checked at seal.

---

## 5. Exactly-once

Send the identical request under the identical key:

```bash
curl -s -i -X POST "$BASE/v1/studies/$STUDY/runs" \
  -H "authorization: Bearer $OPERATOR" -H 'content-type: application/json' \
  -H "idempotency-key: $KEY" -d @/tmp/register.json | head -1
```

`HTTP/1.1 201 Created`, and a body byte-for-byte identical to the first — same
run id, same `auditSeq`, no second run and no second event. The *stored* status
is replayed, so a retrying client cannot tell which attempt did the work.

The fingerprint is taken over the canonicalised body (RFC 8785), so a retry that
re-serialised the same object with its keys in a different order still replays.

Now change something and reuse the key:

```bash
jq '.protocol.objective = "63x"' /tmp/register.json > /tmp/register2.json

curl -s -X POST "$BASE/v1/studies/$STUDY/runs" \
  -H "authorization: Bearer $OPERATOR" -H 'content-type: application/json' \
  -H "idempotency-key: $KEY" -d @/tmp/register2.json | jq .
```

`409 Conflict`, as `application/problem+json`:

```jsonc
{
  "type": "https://aliquot.dev/problems/idempotency-key-reused",
  "title": "Idempotency key reused with a different request body",
  "status": 409,
  "detail": "Key walkthrough-1785613676 was already used on POST /v1/studies/…/runs with a materially different body. Use a new key for a new request, or resend the original body to replay.",
  "instance": "/v1/studies/8e5b69bc-e70c-4984-b04b-f486c3583b6d/runs",
  "idempotencyKey": "walkthrough-1785613676",
  "endpoint": "POST /v1/studies/8e5b69bc-e70c-4984-b04b-f486c3583b6d/runs",
  "correlationId": "bf66ff6b-e629-4345-992f-d2f9994d5466"
}
```

Returning the stored response here would be worse than an error: it would look
like the changed request had been accepted.

---

## 6. Upload

Three calls per artifact. The bytes go straight to object storage over a
presigned URL and never pass through the API process.

### Begin

```bash
curl -s -X POST "$BASE/v1/runs/$RUN/artifacts/qc/walkthrough.csv/upload" \
  -H "authorization: Bearer $OPERATOR" | jq .
```

```jsonc
{
  "alreadyPresent": false,
  "sessionId": "019fbede-7253-7000-b4d1-7a3874ad2941",
  "runArtifactId": "019fbede-71ea-7000-b058-3d44e10173f7",
  "storageKey": "sha256/90/6f/906ff0b0576bdbae214a326a7244c4c583e10da916e3298bc92eead9bcbf2f2a",
  "partSize": "67108864",
  "totalParts": 1,
  "completedParts": [],
  "outstandingParts": 1,
  "expiresAt": "2026-08-08T19:47:57.139Z",
  "auditSeq": "70",
  "parts": [
    { "partNumber": 1, "offset": "0", "sizeBytes": "6934",
      "url": "http://localhost:9000/aliquot/sha256/90/6f/906ff0b0…?X-Amz-Algorithm=…" }
  ]
}
```

The storage key is derived from the content digest, not from the run: identical
bytes are one object. Calling `upload` again on an open session is how resume
works — it returns the parts already recorded and signs fresh URLs for the rest.

### Transfer, then tell the service what landed

```bash
URL=$(…the presigned url…)

ETAG=$(curl -s -D - -o /dev/null -X PUT --data-binary @/tmp/walkthrough.csv "$URL" \
  | grep -i '^etag:' | tr -d '\r' | cut -d' ' -f2)

curl -s -X POST "$BASE/v1/runs/$RUN/artifacts/qc/walkthrough.csv/upload/parts" \
  -H "authorization: Bearer $OPERATOR" -H 'content-type: application/json' \
  -d "{\"sessionId\":\"019fbede-7253-…\",\"partNumber\":1,\"etag\":$ETAG,\"sizeBytes\":6934}" | jq .
```

```jsonc
{ "sessionId": "019fbede-7253-…", "partNumber": 1,
  "etag": "8f3b64358f207a1c1f8727e574f34b3c",
  "sizeBytes": "6934", "completedParts": 1, "totalParts": 1 }
```

Recording parts is what makes a transfer resumable across a client restart.

### Complete

```bash
curl -s -X POST "$BASE/v1/runs/$RUN/artifacts/qc/walkthrough.csv/upload/complete" \
  -H "authorization: Bearer $OPERATOR" -H 'content-type: application/json' -d '{}' | jq .
```

```jsonc
{
  "runArtifactId": "019fbede-71ea-7000-b058-3d44e10173f7",
  "artifactId": "019fbede-72d4-7000-92e0-25c5e1bbd2d2",
  "logicalName": "qc/walkthrough.csv",
  "digest": "906ff0b0576bdbae214a326a7244c4c583e10da916e3298bc92eead9bcbf2f2a",
  "sizeBytes": "6934",
  "deduplicated": false,
  "auditSeq": "71"
}
```

The service asks the store to assemble the parts, then **reads the whole object
back and hashes it**. That digest is what you see here; it is compared against
the declaration from step 4. A multipart ETag cannot do this job — it is the MD5
of the concatenated part MD5s, and its value depends on how the client chose to
chunk the upload.

To see the other outcome, declare a digest and send different bytes: the run is
quarantined and completion answers `422` with
`https://aliquot.dev/problems/digest-mismatch`. The seed leaves one such run in
the dataset (`plate-04`) along with the corrected run that supersedes it.

### The second artifact: nothing to transfer

```bash
curl -s -X POST \
  "$BASE/v1/runs/$RUN/artifacts/calibration/flatfield-2026-02.tif/upload" \
  -H "authorization: Bearer $OPERATOR" | jq .
```

```jsonc
{
  "alreadyPresent": true,
  "runArtifactId": "019fbede-71ec-7000-9a30-7c1b3f9c50b1",
  "artifactId": "019fbed9-0e87-7000-80d0-f46ddd72feb7",
  "logicalName": "calibration/flatfield-2026-02.tif",
  "digest": "37f91d8674561a9129bfce686f354720499df7b308536ad65a4ed85c6514dec1",
  "sizeBytes": "240038",
  "auditSeq": "72"
}
```

No session, no presigned URLs, no bytes. One `artifact` row, three bindings. The
lookup is scoped to the tenant on purpose: a global one would answer "already
present" for a digest this tenant never uploaded, which is an oracle for what
other tenants hold.

---

## 7. Seal

```bash
curl -s -X POST "$BASE/v1/runs/$RUN/seal" \
  -H "authorization: Bearer $OPERATOR" -H 'content-type: application/json' \
  -H "idempotency-key: $KEY-seal" -d '{}' | jq '{state: .run.state, auditSeq, processingJobId}'
```

```jsonc
{ "state": "SEALED", "auditSeq": "74",
  "processingJobId": "019fbede-7301-7000-8813-b5cc2be0a156" }
```

Sealing refuses a run whose manifest is not fully verified (`409`,
`manifest-incomplete`, listing the outstanding names) and recomputes the manifest
digest before freezing it.

The state change, the job row and the audit event are one commit — the queue is
in PostgreSQL for exactly this reason. There is no window in which a run is
sealed and nothing will ever process it:

```bash
docker compose exec -T postgres psql -U postgres -d aliquot -c \
  "select id, queue, dedupe_key, state from aliquot.job where dedupe_key = 'run:$RUN'"
```

---

## 8. What the worker derived

Reading provenance needs the scientist role or better. The operator credential
that produced the data cannot enumerate what the study derived from it:

```bash
curl -s "$BASE/v1/runs/$RUN/derivations" -H "authorization: Bearer $OPERATOR" \
  | jq '{status, detail}'
# 403 — "requires scientist or steward or admin; you hold operator"

curl -s "$BASE/v1/runs/$RUN/derivations" -H "authorization: Bearer $SCIENTIST" \
  | jq '.items[0]'
```

```jsonc
{
  "id": "019fbede-737e-7000-9ca7-c6b5274edbc6",
  "processorName": "metadata-extract",
  "processorVersion": "1.0.0",
  "parameters": { "inspectionLimitBytes": 16777216 },
  "parametersDigest": "eb390cf3a85886a63e641ce51b10faecce2d131cc5d31a7a3f5d93961080c826",
  "inputsDigest": "c54d74b54686179af2c4f9ea9c2358c746f37c49743ef1be7df86444b94421f6",
  "startedAt": "2026-08-01T19:47:57.430Z",
  "completedAt": "2026-08-01T19:47:57.438Z",
  "sourceRunId": "019fbede-71e7-7000-ae3a-6b5c6efc2fb1",
  "inputs":  [ { "artifactId": "019fbede-72d4-…", "role": "primary" } ],
  "outputs": [ { "artifactId": "019fbede-737c-…",
                 "logicalName": "metadata-extract/metadata.json" } ]
}
```

A derivation is identified by `(inputs_digest, processor_name, processor_version,
parameters_digest)` and that unique constraint is the worker's idempotency
guarantee: re-running identical work cannot record a second one.

Two processors run — `checksum-manifest` and `metadata-extract`. Both emit
byte-deterministic JSON, which is why a redelivered job converges instead of
producing a second artifact.

---

## 9. Lineage

```bash
DERIVED=019fbede-737c-7000-8441-102fd8b5fc43

curl -s "$BASE/v1/artifacts/$DERIVED/lineage?direction=ancestors" \
  -H "authorization: Bearer $SCIENTIST" | jq '{nodes: (.nodes|length), edges: (.edges|length), truncated, roots}'
```

```jsonc
{
  "nodes": 9, "edges": 11, "truncated": false,
  "roots": [
    {
      "artifactId": "019fbee3-b1ef-7000-91ae-c471501b8ce4",
      "digest": "37f91d8674561a9129bfce686f354720499df7b308536ad65a4ed85c6514dec1",
      "logicalName": "calibration/flatfield-2026-02.tif",
      "run": { "id": "019fbee3-b0a8-…", "state": "PROCESSED",
               "acquiredAt": "2026-02-11T08:42:00.000Z" },
      "instrument": { "slug": "ls-01", "displayName": "Light-sheet 01" },
      "operator": { "displayName": "Dana Reyes" },
      "processors": [ { "name": "metadata-extract", "version": "1.0.0" } ]
    },
    {
      "artifactId": "019fbee4-4b37-7000-8101-f29300c6616b",
      "digest": "906ff0b0576bdbae214a326a7244c4c583e10da916e3298bc92eead9bcbf2f2a",
      "logicalName": "qc/walkthrough.csv",
      "run": { "id": "019fbee4-4a47-…", "state": "PROCESSED",
               "acquiredAt": "2026-03-04T11:00:00.000Z" },
      "instrument": { "slug": "cf-02", "displayName": "Confocal 02" },
      "operator": { "displayName": "Dana Reyes" },
      "processors": [ { "name": "metadata-extract", "version": "1.0.0" } ]
    }
  ]
}
```

A root is an artifact no derivation produced: bytes that came off an instrument.
There are two here, and the first one is the point — the calibration file was
acquired on a *different* instrument in a *different* run three weeks earlier, and
lineage follows it there because the bytes are the same object. Nobody typed any
of this; it is a traversal of rows the ingestion and processing paths wrote as a
side effect of doing their work. `truncated` says whether the depth cap hid
anything, because a traversal that silently stops is indistinguishable from a
lineage that genuinely ends there.

The same graph as W3C PROV-JSON:

```bash
curl -s "$BASE/v1/artifacts/$DERIVED/lineage.prov.json" \
  -H "authorization: Bearer $SCIENTIST" | jq '.entity | to_entries[0]'
```

```jsonc
{
  "key": "aliquot:artifact/019fbede-72d4-7000-92e0-25c5e1bbd2d2",
  "value": {
    "prov:type": "aliquot:Artifact",
    "prov:label": "qc/walkthrough.csv",
    "prov:generatedAtTime": { "$": "2026-08-01T19:47:57.268Z", "type": "xsd:dateTime" },
    "aliquot:digest": "906ff0b0…",
    "aliquot:sizeBytes": { "$": "6934", "type": "xsd:long" },
    "aliquot:mediaType": "text/csv"
  }
}
```

---

## 10. The audit chain

```bash
curl -s "$BASE/v1/audit?limit=1&targetId=$RUN" -H "authorization: Bearer $OPERATOR" \
  | jq '.items[0]'
```

```jsonc
{
  "seq": "76",
  "actorType": "system",
  "actorLabel": "worker",
  "action": "run.processed",
  "targetType": "run",
  "targetId": "019fbede-71e7-7000-ae3a-6b5c6efc2fb1",
  "payload": { "attempt": 1, "inputArtifactCount": 1, "derivations": [ … ] },
  "payloadDigest": "95693cb9b614e509675753497173e4a4e0ec4a424f4c564410ccf567b76be94b",
  "prevHash": "81b8e7eafba364cfe342d1f8b94ebffbae8ed52e438c89c62c71576c64dd2c4f",
  "hash": "68f5625dfab20331a865c15743f035563e18a565d3416029d148ff959ae253bb",
  "occurredAt": "2026-08-01T19:47:57.444156Z",
  "correlationId": "527d24a4-85b1-4130-8096-48003f5324d5"
}
```

`occurredAt` is the database's own rendering to microsecond precision, because
that exact string is part of the hash preimage — a client verifying offline must
be able to reproduce it without knowing our formatting rules.

Verification needs a steward or an admin:

```bash
curl -s -X POST "$BASE/v1/audit/verify" \
  -H "authorization: Bearer $STEWARD" -H 'content-type: application/json' \
  -d "{\"studyId\":\"$STUDY\"}" | jq .
```

```jsonc
{ "ok": true, "eventsVerified": 79,
  "headHash": "947b08212c675cc8fb9725e0a6fff7b14499574489ee111c98da42d5d4da88b2" }
```

Every event is hashed by the database over `(tenant_id, seq, prev_hash,
payload_digest, occurred_at)`. Four of those five are values the application does
not choose. The verifier recomputes all of it, including each payload's digest
from the stored payload.

---

## 11. Tamper with it

The application role cannot: `UPDATE` and `DELETE` are revoked and a
`BEFORE UPDATE` trigger rejects the statement anyway. So do it as the owner, with
the trigger switched off — the strongest insider this design admits to.

`SEQ` is the `auditSeq` the registration in step 4 returned — the event that says
what the instrument declared. The transaction matters: `ALTER TABLE … DISABLE
TRIGGER` is transactional in PostgreSQL, so a failure halfway does not leave the
audit table writable.

```bash
SEQ=69

docker compose exec -T postgres psql -U postgres -d aliquot <<SQL
begin;
alter table aliquot.audit_event disable trigger audit_event_no_update;
update aliquot.audit_event
   set payload = jsonb_set(payload, '{artifactCount}', '99')
 where seq = $SEQ
   and tenant_id = (select id from aliquot.tenant where slug = 'acme');
alter table aliquot.audit_event enable trigger audit_event_no_update;
commit;
SQL
```

```bash
curl -s -X POST "$BASE/v1/audit/verify" \
  -H "authorization: Bearer $STEWARD" -H 'content-type: application/json' \
  -d "{\"studyId\":\"$STUDY\"}" | jq .
```

```jsonc
{
  "ok": false,
  "brokenAtSeq": "69",
  "reason": "payload_digest",
  "expected": "30a9e3a79f8e5df0abdcbb4faadb095a2770d73809bd1d2e04b577462cf25d61",
  "actual":   "b3beda7f4daa55e7917069036cf73a29566e47ebb74493f24823472ef1679d38"
}
```

`expected` is what the verifier computed from the stored payload; `actual` is
what the row claims its digest is. Two other reasons exist — `hash` and
`prev_hash_mismatch` for a rewritten link, `sequence_gap` for a deleted event.

A failed verification is a `200` carrying `ok: false`, not an error status: the
request succeeded, and the answer is that the chain diverges — located exactly,
by sequence number and by reason.

Put it back — the same statement with `'2'`, the run's real artifact count — and
`verify` returns `ok: true` again.

This is detection, not prevention. An owner who also recomputed every hash from
`seq` 69 forward would produce a chain that verifies. That is what checkpoints
are for: `POST /v1/audit/checkpoints` records `(through_seq, chain_hash)` and is
meant to be mirrored somewhere the database role cannot reach.

```bash
curl -s -X POST "$BASE/v1/audit/checkpoints" \
  -H "authorization: Bearer $STEWARD" -H 'content-type: application/json' \
  -d "{\"studyId\":\"$STUDY\"}" | jq .
```

```jsonc
{ "id": "019fbede-ff38-…", "throughSeq": "81",
  "chainHash": "37efedbc51bc0dcd327b26b7ea6e3308fe337f4c22af7ebd6d6d0812196a4ecd",
  "eventCount": "81", "createdAt": "2026-08-01T19:48:33.209Z", "externalRef": null }
```

---

## 12. Tenant isolation

The seed creates a second tenant with its own study, instrument and run.

```bash
NORTHWIND=$(curl -s -X POST "$BASE/v1/auth/token" -H 'content-type: application/json' \
  -d '{"email":"ines.duarte@northwind.test","tenantSlug":"northwind"}' | jq -r .token)

curl -s "$BASE/v1/runs/$RUN" -H "authorization: Bearer $NORTHWIND" | jq '{status, detail}'
# 404 — "No run with id …". Not 403: whether the id exists is itself tenant data.

curl -s "$BASE/v1/runs?limit=50" -H "authorization: Bearer $NORTHWIND" | jq '.items | length'   # 1
curl -s "$BASE/v1/runs?limit=50" -H "authorization: Bearer $OPERATOR"  | jq '.items | length'   # 7
```

Neither query says `where tenant_id = …`. The separation is a row-level security
policy on every tenant-scoped table, enforced under a `NOINHERIT` login role that
must `SET LOCAL ROLE` before it can read anything at all — so a query that forgot
its scoping returns nothing rather than everything.

---

## What the seeded dataset contains

| tenant | run | state | why it is there |
|---|---|---|---|
| acme | plate-01 | `PROCESSED` | a complete acquisition, four artifacts |
| acme | plate-02 | `PROCESSED` | shares the calibration file with plate-01 — one artifact, two bindings |
| acme | plate-03 | `OPEN` | mid-acquisition: one of three artifacts transferred |
| acme | plate-04 | `QUARANTINED` | the stored bytes did not match the declared digest |
| acme | plate-04-corrected | `PROCESSED` | supersedes plate-04; the quarantined run is never edited |
| acme | plate-05 | `ABANDONED` | given up on, with a reason in the audit chain |
| northwind | grid-01 | `PROCESSED` | a separate tenant, invisible to every acme credential |

## Where to look next

| | |
|---|---|
| Viewer | <http://localhost:3000/> |
| OpenAPI | <http://localhost:3000/docs> |
| MinIO console | <http://localhost:9001> (`aliquot` / `aliquot-dev-secret`) |
| The same arc, automated | `npm run demo` |
