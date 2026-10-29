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

**The stored document is not the same shape as the public `Issue` type** (`@bugbusterhq/types`).
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

Resolvable over the Query API via [`GET /issues/:fingerprint/exemplars`](api.md), which reads this
collection through `getExemplarsByIds`.

## `deploys` collection

```text
deploys:
  version      string, UNIQUE INDEX
  commitSha    string
  deployedAt   string (ISO datetime)
```

The raw material for git correlation (`doc.md` §8) — not yet wired into the Query API or an AI
layer; that's future scope, not v1.

## `logs` collection

One document per application log line. **Never folded** — the opposite of `issues`: for logs the
individual line, and its place in time, is the record.

```text
logs:
  logId       string, UNIQUE INDEX        <- time-sortable: 12 hex epoch-ms + 6 hex sequence + 8 hex random
  timestamp   Date                        <- when it HAPPENED (the app's clock); what users filter/sort by
  receivedAt  Date, TTL INDEX             <- when WE stored it (our clock); what retention expires on
  level       debug | info | warn | error
  message     string                      <- capped at 8 KB
  fields?     object                      <- structured context; keys sanitized; capped at 16 KB
  trace?      { traceId, spanId? }        <- links the line to the request (and to an issue's exemplars)
  service     { name, version, environment }
```

Both times are real BSON `Date`s (unlike the ISO strings elsewhere) because TTL indexes require it.

**Why two timestamps.** Retention must trust only our own clock. Expiring on `timestamp` would let a
client with a wrong clock write a line dated in the far future that is never deleted, or one dated
long ago that is deleted instantly. A far-future client timestamp (> 5 min ahead) is also replaced
with `receivedAt` at ingest so it cannot sit at the top of every view.

**Indexes** — each exists for a specific query:

| Index | Serves |
|---|---|
| `logId` (unique) | Idempotent ingest: a retried batch cannot duplicate lines. |
| `(timestamp -1, logId -1)` | The default view and cursor pagination (`logId` breaks ties within a millisecond). |
| `(service.name, timestamp -1, logId -1)` | "Only `billing-svc`" with the sort served by the index, no in-memory sort. |
| `(trace.traceId, timestamp -1, logId -1)` (partial) | "Everything this request did". Partial so lines with no trace don't bloat it. |
| `receivedAt` TTL (`receivedAt_ttl`) | Retention (default 7 days). |

There is deliberately **no index on `level` or `message`**: level filters ride the time range, and
message search is a bounded case-insensitive substring scan over that range. A MongoDB text index
only matches whole stemmed words — not what anyone searching logs for `o_1042` or `ECONNRESET 10.0.3`
wants.

**Retention is a setting, not a migration.** The TTL is applied when a tenant database is first
used after a process start; changing `BUGBUSTER_LOG_RETENTION_DAYS` updates the existing index in
place (`collMod`), and `0` removes the TTL index entirely.

**Scale note.** Every line is a document carrying several indexes. That is comfortable at the
volumes this project targets; if you reach the point where log ingest rather than error ingest
dominates the database, that is the signal (`ingest-pipeline.md` §10) to give logs their own store.

## What's deliberately NOT here yet

Per `ingest-pipeline.md` §10's growth triggers: no durable log (writes go directly from the ingest
edge into these collections, no queue in between), no probabilistic sketches (the fields above are
exact, not HyperLogLog/DDSketch), no quota/rate-limit collections. See that section for the
specific measurement that brings each one back.
