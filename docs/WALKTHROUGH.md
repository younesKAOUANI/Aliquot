# Walkthrough

Ten scenarios that take about fifteen minutes and exercise every claim this
service makes. Each one states what to do, what you should see, and *why it is
the interesting part* — because "the page loaded" is not evidence of anything.

Everything runs against the live demo at
<https://aliquot.youneskaouani.dev>, signed in with **Try the demo**: no
account, read-only, pre-seeded. To run it locally instead:

```bash
docker compose up            # then http://localhost:3000
```

The `curl` variants need a token. Get one — it takes no request body, which is
the point:

```bash
export A=https://aliquot.youneskaouani.dev
export TOKEN=$(curl -s -X POST $A/v1/auth/demo | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
```

Identifiers below are from the seeded dataset. If yours differ, the seed has
been re-run; the shapes are the same.

---

## 1. Declared, then uploaded — why completeness is checkable

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

## 2. Corruption is caught, and the run is never sealed

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

## 3. Correction by superseding, never by editing

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

## 4. Sealing is an immutability boundary the database enforces

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

## 5. Provenance nobody typed

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

## 6. The same graph, in a standard format

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

## 7. The audit chain, and what verifying it actually does

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

## 8. Tampering is detected, and named

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

## 9. Tenant isolation, from the browser

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

## 10. Exactly-once ingestion under concurrency

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

- an artifact that fails its checksum **quarantines the run** and names the file
- a sealed run is **never edited**; corrections supersede and the original stays
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
| Lineage graph looks cut off | It is wider than the window. Scroll it horizontally. |
| Lots of `session.issued` events | Every demo sign-in is audited, so on a public deployment they are a fair share of the stream — about a quarter of the first page when this was written. Use the action filter to focus on `run.*`. |
| Different identifiers than above | The seed was re-run. Shapes and counts are the same. |
