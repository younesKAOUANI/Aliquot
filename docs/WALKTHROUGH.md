# Walkthrough

Eleven scenarios that take about twenty minutes and exercise every claim this
service makes. Each one states what to do, what you should see, and *why it is
the interesting part* — because "the page loaded" is not evidence of anything.

The first one is the one to do if you only do one: it hands you a tenant of your
own and lets you break something in it. It is written out as `curl` so that every
request is visible. The other ten are clicks against the seeded dataset at
<https://aliquot.youneskaouani.dev>, signed in with **Try the demo**: no account,
read-only, pre-seeded. To run it all locally instead:

```bash
docker compose up            # then http://localhost:3000
```

The `curl` variants need a token. Get one — it takes no request body, which is
the point:

```bash
export A=https://aliquot.youneskaouani.dev
export TOKEN=$(curl -s -X POST $A/v1/auth/demo | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
```

Identifiers in scenarios 2 onwards are from the seeded dataset. If yours differ,
the seed has been re-run; the shapes are the same. Scenario 1 creates its own,
and needs `SANDBOX_MODE=true` if you are running locally.

---

## 1. Break it yourself, in a tenant that self-destructs

Everything else in this document is a seeded dataset: true, but a recording. A
recording of software catching its own planted fault proves nothing, so this
scenario hands you a tenant nobody else can see, lets you corrupt a byte on
purpose, and lets you watch the service refuse it.

The sandbox is **yours alone** — an empty tenant with its own study, operator and
instrument, created for your request and visible to nobody else — and it **self
destructs**: it carries an expiry from the moment it is created, and when that
passes a reaper deletes the tenant outright, rows and objects. Nothing you do
here survives the hour, which is exactly why you are allowed to do it.
([ADR-0021](adr/0021-an-ephemeral-write-sandbox-for-the-public-demo.md))

### 1.1 Take a sandbox

**Do:** ask for one. Like the demo sign-in, it takes no request body.

```bash
export A=https://aliquot.youneskaouani.dev
S=$(curl -s -X POST $A/v1/sandbox)
field() { python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }

export TOKEN=$(echo "$S" | field '["token"]')
export STUDY=$(echo "$S" | field '["sandbox"]["studyId"]')
export INSTRUMENT=$(echo "$S" | field '["sandbox"]["instrumentId"]')
echo "$S" | field '["sandbox"]["expiresAt"]'      # when it stops existing
```

**Expect:** a tenant slug like `sandbox-b022917f`, an `expiresAt` about an hour
out, a quota of five runs and 32 MiB, and `auditSeq: "1"`.

**Why it matters.** That `"1"` is not decoration. The tenant did not exist when
the request arrived, so its audit chain starts at the provisioning event and you
are watching it from genesis — the one thing the seeded demo structurally cannot
show, because its chain was sixty-five events long before you got here. The
session you were handed is an *ordinary* one, not a demo one: admin of that
tenant, and every role check, every row-level security policy and every state
transition applies to it exactly as to a paying tenant. What bounds it is the
tenant — empty, quota-capped and reaped within the hour — rather than the role. A
sandbox that reached the interesting paths by relaxing a guard would prove the
guards are negotiable, not that the system works.

### 1.2 Corrupt one byte and watch it get caught

**Do:** declare a manifest for bytes you have, then upload bytes you have
tampered with.

```bash
python3 - <<'PY'
data = b'ALIQUOT SANDBOX ' * 4096                       # 65 536 bytes
open('field-001.tif','wb').write(data)
open('corrupt.tif','wb').write(data[:1024] + b'\x00' + data[1025:])
PY

DIGEST=$(sha256sum field-001.tif | cut -d' ' -f1)

RUN=$(curl -s -X POST "$A/v1/studies/$STUDY/runs" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'idempotency-key: sandbox-corrupt-01' \
  -d "{\"instrumentId\":\"$INSTRUMENT\",\"acquiredAt\":\"2026-08-04T09:00:00Z\",
       \"manifest\":[{\"logicalName\":\"ch0/field-001.tif\",\"digest\":\"$DIGEST\",
                      \"sizeBytes\":\"65536\",\"mediaType\":\"image/tiff\"}]}" \
  | field '["run"]["id"]')

URL=$(curl -s -X POST "$A/v1/runs/$RUN/artifacts/ch0/field-001.tif/upload" \
  -H "authorization: Bearer $TOKEN" | field '["parts"][0]["url"]')

# The wrong file, with the right size and the right name.
ETAG=$(curl -s -X PUT --data-binary @corrupt.tif -D - -o /dev/null "$URL" \
  | tr -d '\r' | awk 'tolower($1)=="etag:"{gsub(/"/,"",$2);print $2}')

curl -s -X POST "$A/v1/runs/$RUN/artifacts/ch0/field-001.tif/upload/complete" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"parts\":[{\"partNumber\":1,\"etag\":\"$ETAG\"}]}" | python3 -m json.tool
```

**Expect:** `422`, and a problem document naming **both** digests:

```
type             https://aliquot.dev/problems/digest-mismatch
status           422
logicalName      ch0/field-001.tif
declaredDigest   3717e7ef20367ccb…   what you said you would send
computedDigest   f0dfa974452d051b…   what was actually stored
```

and the run itself now `QUARANTINED`, with no `sealedAt`:

```bash
curl -s "$A/v1/runs/$RUN" -H "authorization: Bearer $TOKEN" \
  | python3 -c 'import sys,json;r=json.load(sys.stdin);print(r["state"],r["sealedAt"],r["quarantineReason"])'
```

Those two digests are not examples — the file above is deterministic, so if
yours differ, something other than that one byte changed on the way.

**Why it matters.** Nothing in that exchange trusted you. The object store's ETag
was not used as evidence — a multipart ETag is the hash of a list of part hashes
and depends on how the client chose to chunk, so it cannot be compared against
anything a producer declared. Instead the service read the object back out of
storage and hashed it, streaming, and compared that against the declaration made
*before* the transfer started. That read is the dominant cost of ingest and it is
paid deliberately: a service that never computes a digest can never report a
mismatch, and an integrity claim no test can break is not a claim.

Then notice what happened to the run. It was quarantined rather than left open to
be retried quietly, and it has no `sealed` timestamp — so nothing downstream can
consume it by accident, and the failure is a state in the record rather than a
line in a log somebody has to find.

### 1.3 Correct it the way the system intends

**Do:** supersede the quarantined run — a correction here is a new run that cites
the old one, never an edit — then upload the file you actually declared, and seal.

```bash
RUN2=$(curl -s -X POST "$A/v1/runs/$RUN/supersede" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'idempotency-key: sandbox-corrected-01' \
  -d "{\"reason\":\"ch0 field 001 failed read-back verification; re-transferred\",
       \"instrumentId\":\"$INSTRUMENT\",\"acquiredAt\":\"2026-08-04T09:00:00Z\",
       \"manifest\":[{\"logicalName\":\"ch0/field-001.tif\",\"digest\":\"$DIGEST\",
                      \"sizeBytes\":\"65536\",\"mediaType\":\"image/tiff\"}]}" \
  | field '["run"]["id"]')

URL=$(curl -s -X POST "$A/v1/runs/$RUN2/artifacts/ch0/field-001.tif/upload" \
  -H "authorization: Bearer $TOKEN" | field '["parts"][0]["url"]')

# This time, the file you declared.
ETAG=$(curl -s -X PUT --data-binary @field-001.tif -D - -o /dev/null "$URL" \
  | tr -d '\r' | awk 'tolower($1)=="etag:"{gsub(/"/,"",$2);print $2}')

curl -s -X POST "$A/v1/runs/$RUN2/artifacts/ch0/field-001.tif/upload/complete" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"parts\":[{\"partNumber\":1,\"etag\":\"$ETAG\"}]}" > /dev/null

curl -s -X POST "$A/v1/runs/$RUN2/seal" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'idempotency-key: sandbox-corrected-seal-01' -d '{}' | python3 -m json.tool
```

**Expect:** the seal returns a `processingJobId`, and within a few seconds the run
reaches `PROCESSED` while still naming what it corrected — and the quarantined run
is still there, unchanged, still readable:

```bash
sleep 5      # the worker polls; sealing enqueues, it does not process inline
curl -s "$A/v1/runs/$RUN2" -H "authorization: Bearer $TOKEN" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["state"], d["supersedesRunId"])'
curl -s "$A/v1/runs/$RUN" -H "authorization: Bearer $TOKEN" | field '["state"]'
```

Then a lineage graph nobody typed, and an audit chain that has grown:

```bash
ART=$(curl -s "$A/v1/runs/$RUN2" -H "authorization: Bearer $TOKEN" \
  | python3 -c 'import sys,json;print([m["artifactId"] for m in json.load(sys.stdin)["manifest"] if m.get("artifactId")][0])')

curl -s "$A/v1/artifacts/$ART/lineage" -H "authorization: Bearer $TOKEN" | python3 -m json.tool | head -40
curl -s "$A/v1/audit?limit=50" -H "authorization: Bearer $TOKEN" \
  | python3 -c 'import sys,json;[print(e["seq"], e["action"]) for e in reversed(json.load(sys.stdin)["items"])]'
curl -s -X POST $A/v1/audit/verify -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{}' | python3 -m json.tool
```

**Expect:** a lineage graph containing two artifacts you never uploaded —
`checksum-manifest/manifest.json` and `metadata-extract/metadata.json` — joined
to yours by activities carrying the processor name and version, and reaching back
to `Sandbox instrument` and `Sandbox operator` as agents. And the entire history
of your tenant, fourteen events, verifying as intact:

```
 1 sandbox.provisioned        8 upload.started
 2 run.registered             9 artifact.verified
 3 upload.started            10 run.sealed
 4 run.quarantined           11 run.processing_started
 5 artifact.rejected         12 derivation.recorded
 6 run.registered            13 derivation.recorded
 7 run.superseded            14 run.processed

{ "ok": true, "eventsVerified": 14, "headHash": "9ed6935633c7…" }
```

**Why it matters.** Three claims land at once here.

The correction was not an edit. The broken run still exists, still says
`QUARANTINED`, still carries the reason — and the new run points back at it. There
is deliberately no `superseded_by` column, because writing one would mean mutating
a sealed run to record that it had been corrected. Anything that ever cited the
original still points at exactly what it cited.

Sealing is the immutability boundary the database enforces: after it, the run's
columns cannot be changed by anyone, including someone holding the database
password (scenario 5). It is also what enqueues processing, in the same
transaction as the state change, so there is no window in which a run is sealed
and the work has been forgotten.

The lineage then appears as a *side effect* of that work, recording each
processor's name and version. Nobody typed it, which is exactly why it is worth
trusting — and "we found a bug in metadata-extract 1.0.0, what is affected?" is a
query rather than an investigation.

**When it ends.** Do nothing and the whole tenant — runs, artifacts, audit chain,
the objects in the bucket that nothing else references — is deleted when the
expiry passes. `GET /v1/sandbox` shows the clock and what you have spent:

```bash
curl -s $A/v1/sandbox -H "authorization: Bearer $TOKEN" | python3 -m json.tool
```

Writes stop at the quota (five runs, 8 MiB an artifact, 32 MiB in total) with a
`409`, and stop at the expiry with a `403` — not a `401`, because the token is
genuine and it is the tenant that has gone. Reads keep working either way: being
able to look at what you made is the reason for having made it.

To browse what you built, paste `$TOKEN` into the box at the top of
<https://aliquot.youneskaouani.dev> rather than pressing *Try the demo* — the
viewer will then be looking at your tenant. The scenarios below read the **seeded**
dataset, so put the demo token back before them:

```bash
export TOKEN=$(curl -s -X POST $A/v1/auth/demo | field '["token"]')
```

---

## 2. Declared, then uploaded — why completeness is checkable

**Do:** *Try the demo* → **Runs** → click any `PROCESSED` run.

**Expect:** a *Manifest* panel listing each artifact with a **declared** SHA-256
and a state of `VERIFIED`.

**Why it matters.** The instrument said what it was going to send *before
sending it*. Without that declaration, "the upload finished" and "everything
that was going to be uploaded arrived" are the same sentence, and a truncated
transfer is indistinguishable from a small run. The manifest is what makes the
difference checkable.

```bash
RUN=$(curl -s "$A/v1/runs?state=PROCESSED&limit=1" -H "authorization: Bearer $TOKEN" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["items"][0]["id"])')
curl -s "$A/v1/runs/$RUN" -H "authorization: Bearer $TOKEN" | python3 -m json.tool | head -40
```

---

## 3. Corruption is caught, and the run is never sealed

**Do:** **Runs** → state filter `QUARANTINED` → open it.

**Expect:** the artifact `ch0/plate-04-field-001.png` in state `REJECTED`, and a
quarantine reason naming **both** digests:

```
stored   0904791d535543ac13d22ad9a26e40e67b4630efcbbd0868f4babf673a4e64e2
declared c183827ca950d6a95513ab18264db0dec96b66d2afceabf8a4507cb3cf1526cc
```

**Why it matters.** Aliquot re-read the stored object and hashed it rather than
trusting the uploader or the ETag — an S3 multipart ETag is not the object's
hash, so it cannot verify content. The run has **no `sealed` timestamp**, so
nothing downstream can consume it by accident. And the error names the artifact,
not merely the run, so the operator re-uploads one file rather than a terabyte.

---

## 4. Correction by superseding, never by editing

**Do:** in that quarantined run, note its id. Now clear the filter and open the
`PROCESSED` run whose detail shows a **supersedes** line pointing at it.

**Expect:**

```
supersedes  019fc903-dc98-…  — ch0 field 001 failed read-back verification;
                                re-transferred from the acquisition PC
```

and the quarantined run still there, unchanged, still openable.

**Why it matters.** This is the whole argument for append-only records. The
broken run was not fixed in place and not deleted. Anything that ever cited it —
a figure, a downstream row — still points at exactly what it cited, and the fact
that a correction happened is itself part of the record. There is deliberately
no `superseded_by` column: writing one would mean mutating a sealed run to note
that it had been corrected.

---

## 5. Sealing is an immutability boundary the database enforces

**Do:** try to change a sealed run through the API.

**Expect:** `403`, because the demo session is read-only.

**Why it matters — and how to see the real thing.** The 403 above only proves
the demo guard works. The interesting claim is that a sealed run cannot be
modified *even by someone holding the database password*. That is asserted by
`test/integration/immutability.spec.ts`, which attacks through a **superuser**
connection, column by column:

```bash
npm run test:integration -- immutability
```

A `BEFORE UPDATE` trigger compares `to_jsonb(OLD)` minus an allow-list against
the same projection of `NEW`. Through the API these tests would pass just as
happily with the trigger deleted, which is why they do not go through the API.

---

## 6. Provenance nobody typed

**Do:** open a `PROCESSED` run → click a `VERIFIED` artifact → **Lineage**.

**Expect:** a left-to-right graph, roughly eight nodes:

```
Light-sheet 01 (ls-01) ─┐
                        ├─ run 019fc903 ── ch0/plate-04-field-001.png ─┬─ checksum-manifest 1.0.0 ── manifest.json
Dana Reyes (operator) ──┘                                             └─ metadata-extract 1.0.0 ── metadata.json
```

Edges are labelled `used`, `wasGeneratedBy`, `wasAssociatedWith`,
`wasDerivedFrom`. **The graph scrolls horizontally** — there is more to the
right.

**Why it matters.** Nobody entered any of this. It is the rows the ingestion and
processing paths wrote as a side effect of doing their work, which is what makes
it trustworthy: there is no step where a human could have written something
convenient. Each derivation records the processor's **name and version**, so
"we found a bug in metadata-extract 1.0.0 — what is affected?" is a query rather
than an investigation.

---

## 7. The same graph, in a standard format

**Do:** click **PROV-JSON** next to the direction selector.

**Expect:** a JSON document with top-level `prefix`, `entity`, `activity`,
`agent`, `used`, `wasGeneratedBy`, `wasAssociatedWith`.

```bash
ART=$(curl -s "$A/v1/runs/$RUN" -H "authorization: Bearer $TOKEN" \
  | python3 -c 'import sys,json;print([m["artifactId"] for m in json.load(sys.stdin)["manifest"] if m.get("artifactId")][0])')
curl -s "$A/v1/artifacts/$ART/lineage.prov.json" -H "authorization: Bearer $TOKEN" \
  | python3 -c 'import sys,json;print(sorted(json.load(sys.stdin).keys()))'
```

**Why it matters.** That is W3C PROV — the interchange vocabulary this domain
already uses. Provenance only this service can read is provenance nobody else
can use.

---

## 8. The audit chain, and what verifying it actually does

**Do:** **Audit chain** → set the action filter to `run.* only` → press **Verify
chain**.

**Expect:** the stream newest-first, and

```
chain intact — 65 events, head 2f8b7035402b…
```

The count grows every time somebody presses *Try the demo* — a sign-in is
itself an audited event — so yours will be higher. What matters is `intact`.

**Why it matters.** Each event carries the hash of its predecessor. Verification
does not read a stored "valid" flag — it recomputes every hash in TypeScript
from the stored columns, deliberately *not* reusing the SQL function that wrote
them, because a verifier sharing an implementation with the appender can only
prove the implementation agrees with itself.

Four of the five hash inputs are chosen by the database, not the application:
sequence number, previous hash, timestamp, and tenant. The audited party cannot
pick its own tamper-evidence.

```bash
curl -s -X POST $A/v1/audit/verify -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{}' | python3 -m json.tool
```

---

## 9. Tampering is detected, and named

The demo is read-only, so this one runs locally. It is the single most worthwhile
thing in this document.

```bash
docker compose up -d --wait api worker && docker compose up seed
docker compose run --rm demo
```

**Expect**, at step 9: the driver disables the append-only trigger **as the
database owner**, rewrites one event's payload, and re-verifies:

```
ok              false
broken at seq   65
reason          payload_digest
expected        a1bbbfd73894cd37…
actual          5b4ae3e7bbe7d1c3…
```

then restores the payload and verification returns clean.

**Why it matters — including what it does not prove.** Detection names the exact
sequence number and which component diverged. But an attacker with the database
password who rewrote the event **and recomputed every subsequent hash** would
produce a chain that verifies. Chaining raises the cost of tampering from one
`UPDATE` to a full rewrite; it does not make it impossible. There is a test
asserting that undetected case, because overclaiming here is the usual way this
pattern is oversold. Closing it needs chain heads mirrored somewhere the database
role cannot reach — `audit_checkpoint.external_ref`, not yet populated.

---

## 10. Tenant isolation, from the browser

**Do:** in the demo session, note the runs you can see — all in study
`lightsheet-2026`, tenant `acme`. The seed also creates a second tenant,
`northwind`, with its own study and run. You will not see it.

**Expect:** requesting a `northwind` run id returns **`404`, not `403`**.

**Why it matters.** A 403 would confirm the identifier is real and belongs to
somebody. More importantly the isolation is not the API's doing: every
tenant-scoped table has a forced row-level security policy, and the application
connects as a role without `BYPASSRLS` that the service refuses to boot without.
`test/integration/isolation.spec.ts` issues deliberately **unscoped** queries —
no `WHERE tenant_id` anywhere — across every table found in the catalogue, and
asserts zero rows. The claim is not "the application filters correctly", it is
"isolation holds when the application is wrong".

---

## 11. Exactly-once ingestion under concurrency

Read-only, so this is a test rather than a click:

```bash
npm run test:integration -- idempotency
```

**Expect:** among others, eight genuinely concurrent identical registrations
producing **exactly one** run row, and a replay whose body differs only in JSON
key order treated as a **replay rather than a conflict**.

**Why it matters.** The second case is what makes RFC 8785 canonicalisation
load-bearing rather than decorative: a client that re-serialises the same object
on retry must be recognised as retrying. The concurrency is handled by a unique
constraint, not an application lock — there is no check-then-act and therefore no
race window.

---

## What you should be able to say afterwards

If the walkthrough did its job, you can now state — and check — that:

- an artifact that fails its checksum **quarantines the run** and names the file —
  and you saw it happen to bytes **you** corrupted, not to a fixture
- a sealed run is **never edited**; corrections supersede and the original stays —
  and you superseded one yourself, in a tenant that then deleted itself
- lineage reaches **instrument and operator**, with processor versions, and
  exports as W3C PROV
- the audit chain **detects tampering and says where**, and is honest about the
  case it cannot detect
- tenants are isolated **below the application**, so an application bug leaks
  nothing

And what it deliberately does not do: analyse images, call bases, or interpret
results. It is the layer underneath those.

---

## If something does not match

| Symptom | Cause |
|---|---|
| Empty runs table | Not signed in. Press **Try the demo**. |
| `503` from `/v1/auth/demo` | The stack is up but unseeded — `docker compose up seed`. |
| `404` from `/v1/sandbox` | `SANDBOX_MODE` is off on that deployment. A disabled endpoint is absent rather than forbidden, so a scanner learns nothing. Locally, set it in `.env`. |
| `429` from `/v1/sandbox` | Six sandboxes a minute from one address. Each one creates a tenant, so the limit is lower than the demo's. Wait for `Retry-After`. |
| `403` with `sandbox-expired` | Your hour is up and the tenant has been reaped. `POST /v1/sandbox` again; nothing is recoverable, which is the arrangement. |
| `409` with `sandbox-quota-exceeded` | Five runs or 32 MiB. Start another sandbox. |
| The `PUT` to the presigned URL fails | That URL points at the object store, not at this service — bytes never transit the API. Check the URL has not expired (one hour) and that nothing is rewriting the request. |
| Lineage graph looks cut off | It is wider than the window. Scroll it horizontally. |
| Lots of `session.issued` events | Every demo sign-in is audited, so on a public deployment they are a fair share of the stream — about a quarter of the first page when this was written. Use the action filter to focus on `run.*`. |
| Different identifiers than above | The seed was re-run. Shapes and counts are the same. |
