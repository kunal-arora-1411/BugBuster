# Query API Reference

Implemented in `packages/backend/src/server.ts`. Every route requires
`Authorization: Bearer <apiKey>`; a missing or unrecognized key returns `401` before any tenant
database is touched (see [`schema.md`](schema.md) on why that ordering is the actual isolation
mechanism).

## `POST /ingest`

The wire endpoint the Agent (or, in direct/fallback mode, the SDK itself) posts batches to.

- **Body:** NDJSON-encoded `Envelope` (`@bugbuster/types`), optionally zstd-compressed with
  `Content-Encoding: zstd` — set automatically by `@bugbuster/agent`'s `AgentHttpClient`.
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

## Not yet built

- Any write/management endpoints (creating orgs, rotating API keys) — `ControlDb.createOrg` exists
  as an admin/test helper only, not exposed over HTTP. This is a considered v1 choice, not an
  oversight (see `packages/backend/src/create-org-cli.ts`): at pilot scale, org creation is rare
  enough that a CLI run by whoever operates the backend is the honest answer, not a speculative
  admin API surface with its own auth model to secure and maintain.
