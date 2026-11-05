# Query API Reference

> **Interactive docs:** every backend serves Swagger UI at **`/docs`** and the OpenAPI 3.1 document
> at **`/openapi.json`** (no API key needed for either). A copy is committed at
> [`openapi.json`](openapi.json) for Postman, Insomnia, or client generators — import it directly.
> After changing a route, regenerate it with `pnpm build && pnpm --filter @bugbusterhq/backend
> openapi`; a unit test fails if it's stale or a route is undocumented.

Implemented in `packages/backend/src/server.ts`. Every route requires
`Authorization: Bearer <apiKey>`; a missing, unrecognized or revoked key returns `401`, and a key of
a disabled organization `403`, before any tenant database is touched (see [`schema.md`](schema.md) on why that ordering is the actual isolation
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
| `service` | Only issues seen in this service (the SDK's `project`). Pages stay within it. |
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
      "title": { "type": "TypeError", "message": "Cannot read properties of undefined" },
      "services": ["orders-api"],
      "environments": ["production"],
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

`services` lists every service the issue was seen in. The SDK groups errors per service (from
0.3.0), so it is normally one name: the same error in two services is two issues. Issues grouped by
an older SDK can list several.

## `GET /issues/facets`

`{ "services": ["billing-svc", "orders-api"] }` — every service any issue was seen in, sorted, for
the Issues view's service filter.

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
| `traceId` | Everything logged during one request — the link from an error to its logs. With SDK 0.3 on both sides of a call, this includes the lines from every service the request went through. |
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
org, so a newly deployed service can take a minute to appear.

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

`POST /admin/orgs` also accepts an optional `"logRetentionDays"` (0 to 3650; 0 keeps logs
forever). Without it, the org uses the backend's `BUGBUSTER_LOG_RETENTION_DAYS`.

It also accepts `"keyName"` for the first key (default `"Default key"`), and returns that key's
`keyId` with it.

The admin page at **`GET /admin`** uses every route below. It's a web page, served only when an
admin token is configured.

## `GET /admin/orgs`

Every org with its status, the retention in effect, and its keys. Keys are listed by name with
their dates, never the key or its hash.

```json
{ "orgs": [{
  "orgId": "acme", "name": "Acme Corp", "dbName": "bugbuster_org_acme",
  "createdAt": "2026-10-01T09:00:00.000Z", "disabled": false,
  "logRetentionDays": 30, "retentionOverridden": true,
  "keys": [{ "keyId": "key_3f9a1c2d4e5b", "orgId": "acme", "name": "checkout-api production",
             "createdAt": "2026-10-01T09:00:00.000Z", "lastUsedAt": "2026-11-03T08:12:00.000Z" }],
  "alerts": { "enabled": true, "recipients": ["dev@acme.com"], "services": [],
              "environments": ["production"], "includeStack": true,
              "since": "2026-11-05T09:00:00.000Z", "sentLastHour": 1,
              "lastSentAt": "2026-11-05T09:41:12.000Z" }
}],
  "emailAlerts": { "configured": true, "from": "alerts@yourdomain.com" } }
```

`emailAlerts.configured` is false when the backend has no Brevo key: alert settings can still be
saved, and apply once it does. `alerts.lastError` (with `lastErrorAt`) says why the last send
failed, if it did.

## `PATCH /admin/orgs/:orgId`

Changes an org. Admin token, as above. Send one or more of:

- `"name"`: the display name.
- `"logRetentionDays"`: a whole number of days from 0 (keep forever) to 3650, or `null` to go back
  to the backend default. Applied to the org's TTL index immediately, for every backend process.
- `"disabled": true | false`: a disabled org's keys get **`403 organization is disabled`** on every
  route, both sending and reading, until it is enabled again. Its data is kept. This takes effect
  within a minute on every backend instance.

**`200`:** the org, in the `GET /admin/orgs` shape · **`400`** nothing to change, or an invalid
value · **`401`** wrong admin token · **`404`** no such org, or admin disabled.

## `PUT /admin/orgs/:orgId/alerts`

Sets an org's email alerts (replacing the previous setting). Admin token.

```json
{ "enabled": true, "recipients": ["dev@acme.com", "oncall@acme.com"],
  "services": [], "environments": ["production"], "includeStack": true }
```

- `recipients`: up to 20 addresses, at least one when `enabled`. Each gets their own copy.
- `services` / `environments`: only issues seen in one of these; empty or absent = all.
- `includeStack` (default `true`): whether emails include the top of the stack trace.

Switching alerts on starts from now: issues that appeared while they were off are not emailed.
What sends an email is described in the README's [Email alerts](../README.md#email-alerts).

**`200`:** the org, in the `GET /admin/orgs` shape · **`400`** an invalid value · **`401`** wrong
admin token · **`404`** no such org, or admin disabled.

## `POST /admin/orgs/:orgId/alerts/test`

Sends a test email to the org's saved recipients. **`200`** `{ "sentTo": 2 }` · **`400`** no
recipients saved · **`409`** the backend has no Brevo key · **`502`** Brevo refused the email; the
error says why (for example an unverified sender).

## `GET` or `POST /internal/alerts/run`

For a scheduler. Sends every org's pending alerts: ones that waited for the hourly cap, or whose
send failed. Needs `Authorization: Bearer <BUGBUSTER_CRON_SECRET>` (or Vercel's `CRON_SECRET`,
which Vercel Cron sends with its `GET`); **`404`** when neither is set, **`401`** when it's wrong.

```json
{ "configured": true, "orgs": 3, "emails": 1, "alerted": 2, "errors": 0 }
```

## `POST /admin/orgs/:orgId/keys` and `DELETE /admin/orgs/:orgId/keys/:keyId`

- **`POST`** with `{ "name": "orders-worker production" }` creates another key and returns it
  (**once**, with `Cache-Control: no-store`).
- **`DELETE`** revokes one key. Requests with it get `401 invalid api key` from then on: at once on
  the instance that handled the revoke, and within a minute on the others. The org's other keys keep
  working. A revoked key stays listed with its `revokedAt`, and revoking twice is harmless.

## `POST /admin/maintenance/cleanup-events`

Deletes stored example events no issue uses (left by older backends). `{ "dryRun": true }` only
counts, and `"orgId"` limits it to one org. Returns `{ "dryRun", "total", "orgs": [{ "orgId",
"events" }] }`. Events written in the last ten minutes are never touched.

## `GET /admin/events`

The admin change history, newest first, `?limit=` up to 200. Each entry is `{ "at", "action",
"orgId", "detail" }`, where `action` is one of `org.created`, `org.renamed`,
`org.retention_changed`, `org.disabled`, `org.enabled`, `key.created`, `key.revoked`,
`events.cleaned_up`.

## `GET /admin/storage`

What each org stores, largest first. Admin token, as above. Read-only: it creates nothing, even
for an org that has never sent data. `?orgId=acme` reports on one org.

```json
{
  "generatedAt": "2026-11-03T10:00:00.000Z",
  "defaultLogRetentionDays": 7,
  "totalBytes": 48291840,
  "orgs": [{
    "orgId": "acme", "name": "Acme Corp", "dbName": "bugbuster_org_acme",
    "logRetentionDays": 30, "retentionOverridden": true,
    "collections": {
      "logs":   { "documents": 412880, "dataBytes": 151027712, "storageBytes": 31981568, "indexBytes": 14958592, "compression": "zstd" },
      "issues": { "documents": 37, "dataBytes": 61440, "storageBytes": 36864, "indexBytes": 73728, "compression": "snappy" },
      "events": { "documents": 214, "dataBytes": 466944, "storageBytes": 172032, "indexBytes": 69632, "compression": "snappy" }
    },
    "totalBytes": 47292416,
    "logsPerDay": [{ "date": "2026-10-28", "lines": 58210, "estimatedBytes": 21292032 }],
    "unreferencedEvents": 0
  }]
}
```

`storageBytes` is what the documents take on disk after compression, `dataBytes` their size
before it. `logsPerDay` covers the last 7 UTC days (shortened above). `unreferencedEvents` counts
stored example events no issue uses; `pnpm --filter @bugbusterhq/backend cleanup-events` deletes
them.

## Not yet built

- Searching inside structured `fields` (e.g. `?field.orderId=o_1042`) — fields are stored as real
  sub-documents with Mongo-safe keys, so this is a query addition, not a schema change.
- Separate admin accounts. There is one shared admin token, so the change history records what
  changed and when, but not who changed it.
- Read-only keys. Every org key can both send and read, so a developer with a dashboard key could
  also send data.
- More alert kinds: a resolved issue coming back, a sudden spike in a known issue, and daily
  digests. Today an email means a new issue, or one newly seen in an environment or service.
- Teams managing their own alert recipients. Recipients are set by the operator on `/admin`.
