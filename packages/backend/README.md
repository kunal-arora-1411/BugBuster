# @bugbuster/backend

Ingest edge + processing + Query API — one Node process in v1
(see [`docs/architecture/ingest-pipeline.md`](../../docs/architecture/ingest-pipeline.md) §8,
§10, and blueprint plate 01/08). No durable log, no separate processing tier yet — see the
implementation plan's §10 growth triggers for what brings those back.

## Tenant isolation — the point of this package

```
Bearer <apiKey> --> ControlDb.resolveApiKey() --> { orgId, dbName } --> client.db(dbName)
                     (bugbuster_control only)                          (THIS org's database,
                                                                         structurally — nothing
                                                                         downstream can reach
                                                                         another org's data)
```

Every route resolves auth **before** touching any tenant-scoped code (`server.ts`'s
`requireOrg` helper). There is no shared collection with an `org_id` filter to forget — isolation
is which database a connection handle even points at, not application discipline. This is tested
directly in `test/integration/cross-org-isolation.test.ts`, including an assertion on the actual
resolved `dbName`, not just "org B's data didn't appear in the response."

## MongoDB schema

See [`docs/schema.md`](../../docs/schema.md) for the full reference. Short version: one
`bugbuster_control` database (org lookup), one `bugbuster_org_<name>` database per organization
with `issues` / `events` / `deploys` collections. The **stored** `issues` document differs from
the **public** `Issue` wire shape (`@bugbuster/types`) — see the comment atop
`src/db/collections/issues.ts` for why: exact `usersAffected`/`duration`/`topEndpoints` are
*derived* at read time from raw stored ingredients (a deduplicated user-ID set, raw duration
samples, raw endpoint counts), because deriving them exactly requires the underlying values, not
an already-summarized number.

## A real bug this test suite caught

`test/integration/mongo-writes.test.ts`'s concurrency test failed on the first real run: 49 counted
instead of 50 under 50 concurrent upserts to a brand-new fingerprint. Two distinct causes, both
fixed in `src/db/collections/issues.ts`:

1. When a `FoldDelta` has no endpoints (`endpointCounts: {}`), `$inc` never mentions the
   `endpointCounts` field at all, so it never gets created on a fresh document — `Object.entries`
   on the missing field then threw. Fixed by conditionally defaulting it via `$setOnInsert`, only
   when doing so can't conflict with a dotted `$inc` path in the same operation.
2. Two concurrent upserts can both see "no matching document" and both attempt an insert; the
   unique index on `fingerprint` lets exactly one succeed, and the other needs to retry as a plain
   update rather than silently losing that occurrence's count. `upsertFoldDelta` now catches the
   duplicate-key error and retries once.

Left as a scar on purpose — see the code comments at the exact lines.

## v1 nuance: "never parse the body"

`ingest-pipeline.md` §8.1 describes the ingest edge as never parsing untrusted payloads, deferring
that to a separate processing tier reading off a durable log. v1 has no such tier — `edge.ts` and
`processor.ts` are separate modules in the **same** process specifically so that when the durable
log lands (a growth trigger, not a v1 feature), only `processor.ts` moves behind a queue consumer.
Until then, the guarantee is narrower: the edge authenticates and enforces the size limit without
parsing; the JSON parse happens exactly once, in `processor.ts`, because there's nowhere else for
it to happen yet.

## Testing

```bash
pnpm test              # unit tests — no MongoDB needed
pnpm test:integration  # spins up a real mongod via mongodb-memory-server, no Docker required
```
