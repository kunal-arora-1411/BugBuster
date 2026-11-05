# BugBuster — Root Cause Across Services

Status: **design, targeting 0.4.0.** The code follows it section by section.

## 1. The problem

One failure deep in a call chain shows up as one issue in every service above it:

```text
checkout ──▶ orders ──▶ inventory ──▶ MongoDB  (timeout)
   │            │            └─ MongoTimeoutError          ← the cause
   │            └─ "inventory returned 500"                 ← a symptom
   └─ "orders returned 500"                                 ← a symptom of a symptom
```

During an incident the Issues list shows all of them spiking together, and whoever is on call has
to work out by hand which one started it. We want the dashboard to say it: **this issue was
caused by that one**, and, followed all the way up, **this is the root cause**.

## 2. Why the usual answer does not work here

Tracing systems answer this on the backend from complete traces: keep every span, rebuild each
request's tree, find the deepest error. BugBuster cannot, by design. The SDK folds errors before
they leave the process (ingest-pipeline.md §4), so of 50,000 timeouts only a handful of example
events — and their trace ids — ever reach the backend. Joining example events by trace id
works only for the rare request that happened to be picked as an example in *every* service.

Keeping every trace id would undo the fold, which is the project's whole point. So cause and
effect has to be worked out **where the fold happens — in the SDK — and folded too.**

## 3. The idea: name the failure in the response, count the link in the caller

Every hop between two instrumented services is an HTTP call, and the callee already knows the
one fact the caller is missing: *which issue* this failure is.

1. **The callee says which issue it failed with.** When a request that came from another traced
   service ends in a 5xx, the SDK adds one response header:

   ```http
   HTTP/1.1 500 Internal Server Error
   X-BB-Cause: fp_3fa9c01d2b7e4410
   ```

   The value is the fingerprint of the error that request captured (the first one), or of the
   synthetic `HandledHttpError` the SDK records for a 5xx nothing else reported.

2. **The caller remembers it for the rest of the request.** When an instrumented `fetch` (or a
   call the app reports with `bb.noteDownstreamResponse`) gets a 5xx carrying `X-BB-Cause`, the
   fingerprint is stored on the current request's context.

3. **The caller's next error records a link.** Every error captured in that request afterwards
   is tagged `causedBy: <that fingerprint>`. The fold table counts, per fingerprint, how many of
   its occurrences had each cause:

   ```json
   { "fingerprint": "fp_c3d4…", "count": 49870, "causedBy": { "fp_3fa9…": 49870 }, … }
   ```

4. **Links fold like errors.** 50,000 occurrences still cost one fold record; the link is a few
   bytes inside it. The Agent sums `causedBy` across processes the same way it sums counts.

5. **The backend keeps a graph of issues.** Each `(cause, effect)` pair is one document with a
   running count. Issues are the nodes, links are the edges, and the dashboard reads the graph.

The chain is built **one hop at a time**: `inventory` tells `orders`, `orders` tells `checkout`.
No service ever needs to know more than its immediate callee, and no trace has to be kept whole.

## 4. Wire format

| Where | Field | Shape | Notes |
|---|---|---|---|
| HTTP response | `X-BB-Cause` | `fp_` + 16 hex | Only on 5xx, only to traced callers (§7). |
| `FoldDelta` | `causedBy` | `Record<fingerprint, count>` | Optional; omitted when empty. At most 16 causes per delta. |
| `BugBusterEvent` (example) | `causedBy` | fingerprint | Optional; the cause of that one occurrence, so an example is evidence for the link. |

Both new fields are optional, so older SDKs, Agents and backends keep working: an old backend
ignores the field, an old SDK never sends it, an old Agent forwards the first delta's map only
(under-counting links, never inventing them).

## 5. Storage — `issue_links`, one collection per org database

```ts
{
  cause: "fp_3fa9…",        // the issue that failed first (callee side)
  effect: "fp_c3d4…",       // the issue it caused (caller side)
  count: 49870,             // occurrences of `effect` that followed a `cause` failure
  firstSeen: "2026-11-05T…",
  lastSeen:  "2026-11-05T…",
}
```

- Unique index `(cause, effect)`; the write is one atomic `$inc` upsert per pair, applied right
  after the fold's own upsert — the same non-idempotency the fold already accepts (a retried
  envelope double-counts both, consistently).
- Index `(effect, count)` for "what caused this", `(cause, count)` for "what did this cause".
- A self-link (`cause === effect`) is dropped; it carries no information.
- Database-per-org isolation (§8.4 of ingest-pipeline.md) holds automatically: a link can only be
  written into the database of the org whose key sent it, so an `X-BB-Cause` value from another
  org's service names a fingerprint that simply does not exist here.

## 6. Reading the graph

**Share.** A link's *share* is `link.count / effect.count`: the fraction of the effect's
occurrences that followed that cause. Counts are lifetime counts on both sides, so the share is
honest even when the issue existed long before the incident.

**Symptom.** An issue is a *symptom* when its strongest incoming link has a share of at least
**0.5** — most of the time it happens, it happens because something downstream failed first.

**Root cause.** Start at an issue and repeatedly step to its strongest cause while that step's
share is ≥ 0.5. Stop at an issue with no such cause (that is the root), at a cycle, or after 8
hops. If the walk moved at all, the issue it stopped at is the root cause.

API:

- `GET /issues` — each issue carries `causedBy: { fingerprint, count, share }` for its strongest
  cause, when it has one. One extra indexed query per page, not per issue.
- `GET /issues/:fingerprint/causes` — the full neighbourhood:
  ```json
  {
    "rootCause": { "issue": { … }, "path": ["fp_c3d4…", "fp_a1b2…", "fp_3fa9…"] },
    "causedBy": [ { "issue": { … }, "count": 49870, "share": 0.99 } ],
    "caused":   [ { "issue": { … }, "count": 49602, "share": 0.98 } ]
  }
  ```
  `rootCause` is `null` when the issue is not a symptom. Lists are strongest first, capped at 20.

Dashboard:

- Issues list: a symptom's row says *caused by &lt;title&gt; in &lt;service&gt;*.
- Issue detail: a **Cause and effect** block — the root cause (one click away), what this issue
  was caused by, and what it caused, each with its count and share.

## 7. Costs and safety

**Hot path.** Nothing is added to a request that succeeds. On a 5xx to a traced caller, the
fingerprint of the request's error is computed when the response headers are written (stack
parse + one SHA-256, tens of microseconds) and **cached on the error**, so the flush reuses it
instead of computing it again — the work moves earlier, it is not done twice. On the caller, one
header read per failed downstream response.

**What leaks.** `X-BB-Cause` is an opaque hash. It is sent only when the incoming request carried
a `traceparent` — i.e. the caller is another traced service, almost always internal. Browsers
and outside clients never send one, so they never see the header. `causeHeader: false` on the
Express integration turns it off entirely. On the reading side, only calls that `instrumentFetch`
propagates trace headers to (`propagateTo`) are read, and a value that is not a well-formed
fingerprint is ignored.

**Memory.** One optional string on the request's context; at most 16 cause counters per
fingerprint per flush window, inside the existing fold-table cap.

## 8. What it cannot see (stated, not hidden)

- **Both sides must run the SDK.** A callee without BugBuster sends no header; the caller's error
  is then its own root, which is the honest answer from what we know.
- **A caller that swallows the failure** and later throws something unrelated in the same request
  still gets the link — the cause is "a downstream call failed earlier in this request", which is
  usually but not always why. The share threshold keeps an occasional coincidence from labelling
  an issue a symptom.
- **Non-HTTP hops** (queues, gRPC) are not covered yet. The SDK side is one call —
  `noteDownstreamResponse({ status, headers })` — so a queue consumer or gRPC client can report
  the cause the same way once a producer-side carrier exists.
- **Retries.** A request that fails downstream, retries, and succeeds still had a failure: an
  error captured afterwards links to it. Only a *later* failure in the same request replaces the
  remembered cause.

## 9. Why this is original

Cross-service root cause usually needs complete traces, kept and joined after the fact. Here it
is computed from two things BugBuster already has before anything is sent — the callee's
client-side fingerprint and the caller's fold table — and it survives the fold intact. That is
the same argument the fold itself makes (ingest-pipeline.md §4.3): decide where the data is, so
the expensive version never has to be shipped.
