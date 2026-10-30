# Query API Reference

> **Interactive docs:** every backend serves Swagger UI at **`/docs`** and the OpenAPI 3.1 document
> at **`/openapi.json`** (no API key needed for either). A copy is committed at
> [`openapi.json`](openapi.json) for Postman, Insomnia, or client generators — import it directly.
> After changing a route, regenerate it with `pnpm build && pnpm --filter @bugbusterhq/backend
> openapi`; a unit test fails if it's stale or a route is undocumented.

Implemented in `packages/backend/src/server.ts`. Every route requires
`Authorization: Bearer <apiKey>`; a missing or unrecognized key returns `401` before any tenant
database is touched (see [`schema.md`](schema.md) on why that ordering is the actual isolation
mechanism).

## `POST /ingest`

The wire endpoint the Agent (or, in direct/fallback mode, the SDK itself) posts batches to.

- **Body:** NDJSON-encoded `Envelope` (`@bugbusterhq/types`), optionally zstd-compressed with
  `Content-Encoding: zstd` — set automatically by `@bugbusterhq/agent`'s `AgentHttpClient`.
- **Success:** `202 Accepted`, empty body, with backpressure directive headers attached:

  | Header | Meaning |
  |---|---|
  | `X-BB-Sample-Directive` | JSON `{error, log, span}` — per-type sample rates the SDK should obey |
  | `X-BB-Suppress-Fingerprints` | JSON array of fingerprints to send counts-only for |
  | `X-BB-Config-Version` | integer, for the SDK to detect a directive change |
  | `X-BB-Retry-After` | present only when the client should pause before its next send |

  v1 reality (`packages/backend/src/directives.ts`): at pilot scale there's nothing to sample down
  or suppress, so this always returns the "keep everything" directive. The wire mechanism is real
  and tested; the decision behind it is intentionally trivial until a measured need exists (§10 of
  `architecture/ingest-pipeline.md`).

- **Failure:**
  - `401` — missing/invalid `Authorization`
  - `413` — body exceeds `ingestMaxBodyBytes`

## `GET /issues`

Lists the authenticated org's issues, most recently seen first.

**Query params:**

| Param | Meaning |
|---|---|
| `limit` | Max issues to return (default 50, capped at 200). |
| `cursor` | Opaque pagination token from a previous response's `nextCursor`. Omit for the first page. |

**Response:**
```json
{
  "issues": [
    {
      "fingerprint": "fp_08dc8abd61b89b41",
      "count": 2,
      "usersAffected": 0,
      "duration": { "p50": 0, "p95": 0, "p99": 0 },
      "topEndpoints": { "top": [], "other": 0 },
      "releases": [],
      "firstSeen": "2026-09-05T18:32:19.630Z",
      "lastSeen": "2026-09-05T18:32:19.635Z",
      "exemplarRefs": [{ "eventId": "...", "role": "one-novel-stack" }],
      "adjustedCount": 1.0,
      "fidelity": { "isExact": true, "adjustedCount": 1.0 }
    }
  ],
  "nextCursor": "eyJsYXN0U2VlbiI6Ii4uLiIsImZpbmdlcnByaW50IjoiLi4uIn0"
}
```

`nextCursor` is present only when more issues remain; pass it as `?cursor=` to fetch the next page.
It pins `(lastSeen, fingerprint)` together so a page boundary is stable even when two issues share
a `lastSeen` timestamp — treat it as opaque, not as anything to parse or construct client-side. An
invalid or expired-looking cursor returns `400`, never a silently wrong page.

Every issue carries `fidelity` (`packages/backend/src/query/fidelity.ts`) — `isExact: false` means
`adjustedCount !== 1.0`, i.e. sampling was applied and `count` is a weighted estimate, never
presented as unconditional truth (Appendix A's FIDELITY invariant).

## `GET /issues/:fingerprint`

One issue, same shape as an entry in the `/issues` list above. `404` if the fingerprint doesn't
exist **in the authenticated org's own database** — including when it exists in a *different*
org's database, which is indistinguishable from "doesn't exist" by design (see the cross-org
isolation test).

## `GET /issues/:fingerprint/exemplars`

Resolves the issue's `exemplarRefs` (`{eventId, role}` pairs, capped at 6 per issue) to their full
`BugBusterEvent` bodies — message, sanitized stack trace, trace/span IDs, and source location.
This is the drill-down the aggregate route deliberately never inlines (payloads can be large, and
most issue views never need them), so viewing one is an explicit second request.

**Response:**
```json
{
  "exemplars": [
    {
      "eventId": "evt_1",
      "fingerprint": "fp_08dc8abd61b89b41",
      "exemplarRole": "slowest",
      "timestamp": "2026-09-15T12:02:39.584Z",
      "type": "exception",
      "trace": { "traceId": "trace-abc123", "spanId": "span-1" },
      "service": { "name": "checkout-svc", "version": "1.4.2", "environment": "production" },
      "source": { "function": "chargeCard", "file": "src/payments/charge.ts", "line": 88 },
      "error": {
        "type": "TimeoutError",
        "message": "Upstream payment gateway timed out after 5000ms",
        "stacktrace": "TimeoutError: ...\n  at chargeCard (src/payments/charge.ts:88:11)"
      }
    }
  ]
}
```

Ordered per the issue's own `exemplarRefs` order, not Mongo's `$in` return order (unspecified).
`404` under the same rule as `/issues/:fingerprint` (fingerprint not found in the org's own
database). An issue with no recorded exemplars yet returns `{"exemplars": []}`, not an error.

The dashboard (`packages/dashboard`) calls this on row click to show the full event alongside the
aggregate — previously the only way to see one was querying the `events` collection directly.

## `GET /logs`

Application log lines, newest first — the "normal logs" half of the product. Unlike issues, logs
are never folded: one stored document per line (see [`schema.md`](schema.md)).

**Query params** (all optional; combine with AND):

| Param | Meaning |
|---|---|
| `level` | Exact levels to include, comma-separated: `debug`, `info`, `warn`, `error` (e.g. `?level=warn,error`). Case-insensitive. |
| `service` | Exact service name (the SDK's `project`). |
| `environment` | Exact environment (`production`, `staging`, ...). |
| `traceId` | Everything logged during one request — the link from an error to its logs. |
| `q` | Case-insensitive **substring** match on the message. Treated literally: `a.b` matches `a.b`, never `axb`; regex characters are not interpreted. Max 200 chars. |
| `from`, `to` | ISO-8601 bounds on the line's timestamp (inclusive). |
| `limit` | Lines per page (default 100, max 500). |
| `cursor` | Opaque token from a previous response's `nextCursor`. |

**Response:**
```json
{
  "logs": [
    {
      "logId": "01a1871e0423-000006-ff0ff556",
      "timestamp": "2026-10-29T10:04:13.731Z",
      "level": "error",
      "message": "payment capture failed after retries",
      "fields": { "orderId": "o_1042", "code": "GATEWAY_TIMEOUT", "apiKey": "[redacted]" },
      "trace": { "traceId": "ccd02add-7e31-4632-a12a-3a19f5c...", "spanId": "..." },
      "service": { "name": "billing-svc", "version": "3.1.0", "environment": "production" }
    }
  ],
  "nextCursor": "eyJ0IjoxNzYx..."
}
```

`trace` is present only for lines logged inside a request (via the Express integration's
`requestHandler`); background-job lines have none. `fields` is present only when the line had
structured fields. `nextCursor` is present only when older lines remain; it pins
`(timestamp, logId)` so paging is exact even when many lines share a millisecond.

**Ordering:** `logId` is time-sortable (epoch-ms, then a per-process sequence, then random), so
lines written back-to-back in the same millisecond come back in true write order (newest first).

**Errors:** `400` for an unknown `level`, an unparseable `from`/`to`, `from` after `to`, or an
invalid `cursor` — never a silently wrong page. Searches are bounded by a server-side time limit so
a pathological query cannot pin the database.

## `GET /logs/facets`

`{ "services": ["billing-svc", "demo-app"], "environments": ["development", "production"] }` —
the distinct values present in the org's logs, for filter dropdowns. Cached for up to 60 s per
org, and invalidated whenever new logs are ingested.

## Log items on `POST /ingest`

The same endpoint carries logs: an NDJSON envelope may now contain items of
`type: "log"` alongside `fold`, `exemplar`, and `meta`. Each is validated against `LogEntrySchema`
(`@bugbusterhq/types`); a malformed line is discarded without affecting the rest of the batch, and a
line whose `logId` was already stored (a retried batch) is skipped, not duplicated. The backend also
re-applies its own bounds regardless of what the sender claims: messages over 8 KB are truncated,
`fields` over 16 KB are replaced by `{ "_truncated": true }`, field keys containing `.` or starting
with `$` are rewritten, and a timestamp more than 5 minutes in the future is replaced by the
server's time.

Retention: lines older than `BUGBUSTER_LOG_RETENTION_DAYS` (default 7; `0` = keep forever) are
deleted by a MongoDB TTL index on the server's receive time.

## `POST /admin/orgs`

Creates an organization and returns its API key. Authorized by the backend's
`BUGBUSTER_ADMIN_TOKEN` (`Authorization: Bearer <adminToken>`), not by an org key — and when no
admin token is configured, the route answers `404` as if it didn't exist.

- **Body:** `{ "orgId": "acme", "name": "Acme Corp" }` — `orgId` matches `^[a-z0-9][a-z0-9_-]{0,39}$`
  and becomes the database name `bugbuster_org_<orgId>`.
- **`201`:** `{ "orgId", "name", "dbName", "apiKey" }` with `Cache-Control: no-store`. The key is
  generated server-side and **returned only here**; only its SHA-256 is stored.
- **`400`** invalid body · **`401`** missing/wrong admin token · **`409`** the `orgId` or its
  database name is already used by another org (two orgs must never share a database).

## Not yet built

- Searching inside structured `fields` (e.g. `?field.orderId=o_1042`) — fields are stored as real
  sub-documents with Mongo-safe keys, so this is a query addition, not a schema change.
- Rotating or revoking an API key over HTTP. Creating one is possible (`POST /admin/orgs`, below);
  replacing one needs the in-process auth cache (`ingest/edge.ts`, which never expires an entry) to
  expire or be invalidated first, or an old key would keep working on every warm instance.
