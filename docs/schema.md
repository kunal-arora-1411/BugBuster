# MongoDB Schema

Companion to [`architecture/ingest-pipeline.md`](architecture/ingest-pipeline.md) §8.4. This is
the concrete, as-implemented reference — the source of truth is
`packages/backend/src/db/collections/*.ts` and `packages/backend/src/db/control.ts`; this doc
exists so you don't have to reverse-engineer the schema from the code.

## Tenant isolation, structurally

```text
bugbuster_control                  <- one shared database
  orgs: { orgId, name, dbName, apiKeyHash, createdAt }

bugbuster_org_<name>                <- one database PER organization
  issues, events, deploys           <- see below
```

A request resolves its API key against `bugbuster_control.orgs` **before** touching any tenant
database (`packages/backend/src/db/control.ts` → `packages/backend/src/db/tenant.ts`). Every
collection call downstream operates on a `Db` handle bound to exactly one `dbName` — there is no
shared collection with an `org_id` filter to forget. See
`packages/backend/test/integration/cross-org-isolation.test.ts` for the test that verifies this
directly, not just "the response happened not to contain the other org's data."

## `issues` collection

**The stored document is not the same shape as the public `Issue` type** (`@bugbuster/types`).
`usersAffected`, `duration`, and `topEndpoints` are *derived* fields in the public API — computing
them exactly requires the raw underlying values, which the stored document keeps:

```text
issues:
  fingerprint       string, UNIQUE INDEX          <- the fold-merge upsert's key
  count             number                        <- exact, v1 (§4.2)
  userIdSet         string[]                      <- exact deduplicated set; usersAffected = .length
  endpointCounts    Record<string, number>        <- raw counts; top-K computed at read time
  durationSamplesMs number[]                      <- capped at the most recent 1000 (§ below)
  releases          string[]
  firstSeen         string (ISO datetime)
  lastSeen          string (ISO datetime), INDEXED (desc, for dashboard sort)
  exemplarRefs      { eventId, role }[]            <- capped at 6, enforced in application code
  adjustedCount     number, defaults 1.0           <- sampling weight (§5.2 — never omit this)
```

**Why `durationSamplesMs` is capped, not unbounded:** percentiles are computed from the most
recent 1000 samples via `$push` + `$slice: -1000`, not the issue's entire lifetime. A bounded,
honestly-approximate choice — at pilot volume this cap is rarely hit at all.

**The atomic fold-merge upsert** (`upsertFoldDelta`) is one `updateOne` call per `FoldDelta`:
`$inc` for `count` and per-endpoint counts, `$addToSet` for `userIdSet`/`releases`, `$push` for
`durationSamplesMs`. Two things this function specifically guards against (found by the E2E test,
see `examples/demo-app/README.md`):

- An empty `endpointCounts` on the incoming delta means `$inc` never mentions that field at all,
  so `$setOnInsert` conditionally defaults it to `{}` — but *only* when there are no endpoint keys
  in this call, since MongoDB rejects an update touching both a dotted child path
  (`endpointCounts.checkout`) and its parent (`endpointCounts`) as a path conflict.
- Two concurrent upserts can both see "no matching document" and both attempt an insert; the
  unique index lets one succeed and the other gets `E11000`. The function catches that specific
  error and retries once as a plain update — without this, that occurrence's count is silently
  lost under concurrent writers.

## `events` collection

Resolves an early gap between `doc.md`'s informal "BugBuster event model" sketch and the
fold-first architecture that came later — this collection stores exactly that shape, lightly
extended:

```text
events:
  eventId       string, UNIQUE INDEX
  fingerprint   string, INDEXED             <- links back to its issue
  exemplarRole  first | last | slowest | one-per-release | one-novel-stack
  timestamp     string (ISO datetime)
  type          exception | message | span
  trace:        { traceId, spanId, parentSpanId? }
  service:      { name, version, environment }
  source:       { function, file, line }
  error?:       { type, code?, message, stacktrace }
```

Insertion is idempotent (`$setOnInsert` + upsert on `eventId`) — a retried send must not duplicate
the exemplar. Capped at ≤6 per fingerprint, enforced by `issues.ts`'s `addExemplarRef`, not by a
Mongo-level constraint (capped collections don't support a per-key limit).

## `deploys` collection

```text
deploys:
  version      string, UNIQUE INDEX
  commitSha    string
  deployedAt   string (ISO datetime)
```

The raw material for git correlation (`doc.md` §8) — not yet wired into the Query API or an AI
layer; that's future scope, not v1.

## What's deliberately NOT here yet

Per `ingest-pipeline.md` §10's growth triggers: no durable log (writes go directly from the ingest
edge into these collections, no queue in between), no probabilistic sketches (the fields above are
exact, not HyperLogLog/DDSketch), no quota/rate-limit collections. See that section for the
specific measurement that brings each one back.
