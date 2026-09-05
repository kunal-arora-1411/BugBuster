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
  ]
}
```

Every issue carries `fidelity` (`packages/backend/src/query/fidelity.ts`) — `isExact: false` means
`adjustedCount !== 1.0`, i.e. sampling was applied and `count` is a weighted estimate, never
presented as unconditional truth (Appendix A's FIDELITY invariant).

## `GET /issues/:fingerprint`

One issue, same shape as an entry in the `/issues` list above. `404` if the fingerprint doesn't
exist **in the authenticated org's own database** — including when it exists in a *different*
org's database, which is indistinguishable from "doesn't exist" by design (see the cross-org
isolation test).

## Not yet built

- Pagination beyond a fixed `limit` (default 50) on `/issues`.
- Any write/management endpoints (creating orgs, rotating API keys) — `ControlDb.createOrg` exists
  as an admin/test helper only, not exposed over HTTP yet.
- Resolved exemplar payloads inline on an issue response (currently only `exemplarRefs`, i.e.
  `{eventId, role}` pairs — fetching the actual `BugBusterEvent` bodies means calling
  `getExemplarsByIds` directly; not yet wired to a route).
