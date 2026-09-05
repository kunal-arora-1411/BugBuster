# BugBuster — Ingest Pipeline Architecture

> **Status:** Design resolved for v1 (§10). Captures the reasoning behind the collection path:
> SDK → Agent → Ingest Edge → MongoDB. Pre-implementation — no code written yet.
>
> **v1 scope, in one line:** multi-tenant from day one (MongoDB, one database per org) ·
> Node SDK · a required host-local Agent (UDS in, HTTPS out) · single VPS · no Kafka, no
> probabilistic sketches yet. See §10 for the full decision record and the triggers that grow
> each deferred piece back in.
>
> **Companion docs:**
> - `../glossary.md` — plain-English explanation of every term used below
>   (p99, µs, ring buffer, UDS, backpressure, cardinality, sketches…). **Read this first if any
>   vocabulary here is unfamiliar.**
> - `../../doc.md` — project vision & OTel research framing

---

## Why this document exists first

The ingest path is the one part of BugBuster that **cannot be refactored later.**

Everything downstream — storage engine, fingerprint algorithm, correlation, AI layer — can be
rewritten behind an interface. But:

- The **SDK runs inside someone else's process.** Once shipped, its cost profile and failure
  modes are their production problem, and upgrades roll out on their schedule, not ours.
- The **wire format is a contract.** Changing it means supporting N old SDK versions forever.

So the collection path gets designed properly before a line of it is written.

---

## 1. Reframing the problem

Most systems are designed as *"capture events, send events."* That framing loses immediately,
because **event count scales with the customer's traffic, and we have zero control over the
customer's traffic.**

The framing that wins:

> **The SDK is handed a budget — X bytes/sec, Y µs per request, Z MB RAM — and must produce
> maximum diagnostic value inside that budget.**

Once it is a budget problem, the design falls out:

- **Aggregate at the edge** — fold duplicates before they touch the network
- **Sample with math you can invert** — store the weight, never present a sampled count as truth
- **Shed load by priority, not by luck**
- **Carry fidelity metadata** so the dashboard never lies about what was dropped

### 1.1 Two independent adversaries

| | Threat | Failure mode |
|---|---|---|
| **Host side** | Our code runs in their hot path | We add 3ms p99 to their checkout. They rip us out. |
| **Our side** | N customers × error storms | One customer's bad deploy degrades ingest for everyone. |

These are **in tension.** The cheapest behaviour for the host (fire everything immediately, no
batching) is the worst behaviour for our API. The resolution:

> **Push work to where it is cheap.** It is cheapest in the **Agent** and the **Collector** —
> never in the host process, never at the ingest edge.

---

## 2. The layered flow

```text
┌──────────────────── HOST PROCESS (their money) ────────────────────┐
│                                                                    │
│  L0  hot path      capture()  →  ring buffer      < 5µs, 0 syscalls│
│                         ↓ (drop + count if full)                   │
│  L1  worker        fingerprint → FOLD → serialize → compress       │
│                         ↓                                          │
└─────────────────────────┼──────────────────────────────────────────┘
                          │  UDS (µs, no TLS) — same host, required in v1
                          ▼
┌──────────────────── L2  AGENT (host-local, v1) ─────────────────────┐
│  cross-process fold · disk spool · 1 connection · dictionary zstd   │
└─────────────────────────┼──────────────────────────────────────────┘
                          │  HTTPS, keep-alive, backpressure-aware
                          ▼
┌──────────────────── L3  INGEST EDGE (our VPS) ──────────────────────┐
│   auth · quota (org_id) · size · priority · APPEND → 202  p99<15ms │
│   never parses the body                                            │
└─────────────────────────┼──────────────────────────────────────────┘
                          ▼
                  L4  MongoDB — one database per org (§8.4)
                          ▼
                  L5  processing (fold, correlate) · in-process for now
```

The two load-bearing ideas: **L1's fold** and **L3 never parsing the body.** The Agent hop (L2)
is mandatory for every backend-hosted SDK in v1 — direct-to-HTTPS is kept only as the fallback
for environments where a host-local Agent can't run (browser, serverless); see §6.3.

---

## 3. L0 — The hot path: the Hippocratic oath

This layer decides whether anyone adopts BugBuster at all.

### 3.1 Non-negotiables (each becomes a CI test)

1. **Never throw into user code.** Every public entry point wrapped. A telemetry SDK that can
   crash the app is worse than no telemetry.
2. **Never block.** No sync I/O, no lock held across I/O, no unbounded queue.
   *An uncapped queue is just a slower memory leak.*
3. **Every buffer capped in BYTES, not items.** Item caps lie — one 10 MB stack trace blows the
   budget while the item count still looks healthy.
4. **Recursion guard — mandatory.** We instrument their logger → our SDK errors → we log it →
   their logger → our SDK → infinite loop, in production, at 3am. Requires an `in_capture`
   thread-local checked before anything else runs.
5. **Fork-safe.** Python under `gunicorn --preload`, uWSGI, clustered Puma: buffers and
   background threads do not survive `fork()`. Must re-init post-fork
   (`os.register_at_fork`). This is a *guaranteed* bug if not designed in.
6. **Unref'd timers.** Our flush timer must never be the reason their process won't exit.
7. **Bounded shutdown.** Flush on exit, hard-capped (~2s). Never delay a deploy.
8. **Self-throttle.** Measure our own CPU share; over threshold, auto-degrade to counts-only.

### 3.2 What actually costs time, and the fix

| Operation | Naive cost | Fix |
|---|---|---|
| Stack capture | Accessing `.stack` forces V8 to format the whole trace — tens of µs, worse when deep | Unavoidable for exceptions (V8 caches it). But **never parse inline** — hand the raw string to the worker. **Never capture stacks for logs/spans** unless explicitly configured. |
| Context lookup | `AsyncLocalStorage` get is sub-µs, but *having* an ALS active costs per async hop | One ALS store for the whole SDK, holding one object. **Benchmark early** — this is the tax paid on every `await` in their app. |
| Serialization | `JSON.stringify` of a nested request object: 10–100µs | **Never serialize on the hot path.** Push object *references* into the ring. Worker serializes. |
| PII redaction | Regex over a payload | Worker's job. Mark the record's trust level at capture so the worker knows what to scrub. |

**Target: < 5µs for a log, < 50µs for an exception. Zero syscalls, zero JSON, zero allocation
beyond one slot.**

### 3.3 The capture primitive

```text
capture(evt):
  if (in_capture) return                            // recursion guard
  if (!sampler.keep(evt))  { n_sampled++; return }  // ~50ns
  slot = ring.tryClaim()
  if (!slot) { n_dropped++; return }                // drop, never block, never grow
  slot.fill(refs)                                   // no copies, no stringify
```

### 3.4 Drop counters are sacred

Every batch carries a meta-record:

```text
dropped_buffer_full
dropped_quota
sampled_out
buffer_high_water
self_cpu_pct
config_version
```

This enables a feature nobody ships well: **"your instrumentation is degraded — you are seeing
12% of your errors."**

> **Silent data loss is the cardinal sin of observability, and it is unfixable if the counters
> are not designed in from day one.**

---

## 4. L1 — The fold: the real answer to "don't overload the API"

This is the single most important decision in the system, and it is where the vision doc's
*"fingerprint as a core primitive"* claim cashes out.

### 4.1 The scenario

A bad deploy makes `PaymentService.createPayment` throw `PaymentTimeout`
**50,000 times in 10 seconds across 40 pods.**

**Event-oriented system (OTel, plain Sentry):**
50,000 events × ~5 KB = **250 MB** in 10 seconds from 40 pods simultaneously. Ingest either
falls over or rate-limits — and either way the dashboard is wrong during the exact incident it
was bought for.

**Fold-oriented system:** the worker groups by fingerprint *before touching the network.*

```json
{
  "fingerprint": "fp_a1b2c3",
  "window": ["t0", "t0+10s"],
  "count": 50000,
  "users_affected": "<HLL sketch>",
  "duration":       "<DDSketch>",
  "top_endpoints":  "<Space-Saving top-20 + other>",
  "releases": ["2.8.1"],
  "exemplars": ["first", "last", "slowest", "one-per-release", "one-novel-stack"]
}
```

**~40 KB instead of 250 MB — four orders of magnitude**, losing almost nothing that matters:
full stacks retained, counts exact, percentiles accurate.

### 4.2 Sketch choices (target design — v2, see §10)

| Need | Structure | Why |
|---|---|---|
| Cardinality (users/sessions affected) | **HyperLogLog++**, sparse repr | Mergeable across all 40 pods server-side, so "6,921 affected users" is a real deduplicated number — not a sum of overlapping guesses |
| Distributions (latency) | **DDSketch** (over t-digest) | *Relative* error guarantee — the correct primitive for p99 SLO work — and merges cleanly |
| Attribute values (endpoints, tenants, browsers) | **Space-Saving top-K** + explicit `other` bucket | Never store unbounded value sets |

**v1 reality:** at pilot volume (a handful of orgs, pre-prod traffic) these sketches would add
*more* error than they remove — HLL and DDSketch approximate best at high cardinality, and are
measurably worse than an exact count at low N (glossary §8 explains why). v1 stores **exact**
`count`, an exact affected-user count, and an exact top-K, computed directly. The document shape
below keeps the *field names* stable so swapping in a real sketch later is a value-type change,
not a schema migration — see the growth trigger in §10.

### 4.3 Why this is defensible as original work

**OTel structurally cannot do this.** Its data model is per-event and grouping is defined as a
*backend* concern. Making the fingerprint a **client-side primitive** unlocks a ~1000:1
compression a spec-compliant OTel SDK cannot reach.

That is the project's thesis, and it is a real one.

### 4.4 The cost of it (accepted, with mitigations)

Fingerprinting moves into the SDK, so **the algorithm becomes part of the wire contract** and
version skew is real.

- **Mitigation A:** send the raw grouping *inputs* alongside the fingerprint, so the server can
  re-fingerprint on demand.
- **Mitigation B:** keep the durable log replayable, so history can be recomputed when the
  algorithm improves.

### 4.5 Cardinality is the real enemy — not volume

Volume compresses. **Cardinality kills** — it blows up the SDK's fold table, the server-side
index, and query latency. Hard caps at the edge:

- **Max active fingerprints per process per window** (~10k). Beyond that, **coarsen**: strip
  stack frames until entries collide. Degrade gracefully, never OOM.
- **Reject high-cardinality attributes at capture.** Someone *will* put a raw user ID in a tag.
  Detect it, demote it into the exemplar payload, keep it out of the grouping key.

---

## 5. L1.5 — Sampling: getting the decision point right

**The bind:**

- **Head sampling** (decide at trace start) — cheap, but decides *before* we know whether the
  request errored or was slow: precisely the information that determines whether we want it.
- **Tail sampling** (decide after completion) — correct, but needs all spans of a trace buffered
  in one place, and they arrive from *different services*.

### 5.1 Recommended middle path

**Deferred in-process decision.** Buffer a request's spans in-process until the request
completes. The outcome is then known *locally and for free*, allowing retroactive upgrade:
request errored or exceeded p95 → keep everything. Cheap, because the spans never left the
process. Captures ~90% of tail sampling's value with none of the distributed machinery.

**Consistent cross-service sampling without coordination.** Propagate a random threshold `r` in
the trace header; each service keeps if `r < its_own_rate`. Services with *different* rates
still produce coherent traces, with zero negotiation.

**True tail sampling in the Collector** (consistent-hash spans by `trace_id` so a whole trace
lands on one instance, hold ~20s) is a **v2** feature. Do not build it first.

### 5.2 The correctness rule most systems botch

> **Always store the sampling weight.**

Every stored record carries `adjusted_count`. The dashboard reads
*"~50,000 occurrences (2,500 sampled, 20× weight)"* — **never** a raw sampled count presented as
truth.

Retrofitting this is nearly impossible. It is a **schema decision made now.**

---

## 6. L2 — The Agent: a required host-local process in v1

**Resolved (§10): the Agent ships in v1, not v2.** Every backend-hosted SDK talks to a host-local
Agent over UDS; the Agent is the only thing that makes the network hop to the VPS. This section
originally scoped the Agent as a v2 upgrade justified purely by scale — that reasoning is kept
below because it still explains *why* the split is good architecture, but the actual v1 decision
was made independent of hitting that scale: see §10 for the reasoning (mainly: keep the SDK thin
and the transport concerns off the customer's process from day one, rather than migrate to it
under pressure later).

### 6.1 Direct-mode math at 200 pods (the scale argument, kept for context)

200 TLS handshakes · 200 connection pools · 200 independent retry timers · **200 disjoint fold
windows** — so the fold ratio is 200× worse, because each pod only sees its own slice of the
storm. At v1's actual scale (a handful of hosts, one or two SDK-instrumented services per host)
this specific math doesn't bite yet — the win right now is architectural cleanliness (§6.2), not
fold ratio. It becomes a measured win the moment any one host runs more than one instrumented
service, because those services fold together through the shared local Agent before the network
hop.

### 6.2 With a host-local agent

The SDK's entire job collapses to: **serialize, write to a Unix domain socket, forget.**

No TLS, no compression, no retries, no disk, no circuit breaker — **none of it in their
process.** The agent owns all of it, plus:

- **Cross-process folding** — dramatically better ratios once a host runs more than one
  instrumented service, because the Agent sees the whole node
- **One persistent connection per node**
- **Disk spool** — it is our process, so disk is fair game

### 6.3 Dual-mode requirement

The SDK **must work in both modes**, auto-detecting the agent by probing the socket path.

- **Agent mode** = required in v1 for every backend-hosted deployment
- **Direct mode** = the fallback for environments where a host-local Agent cannot run —
  browser and mobile SDKs, and serverless functions (see below) — kept in the SDK as an escape
  hatch, not offered as the default path for backend services
- **Serverless** = direct mode only, or a Lambda-extension equivalent, since there is no
  long-lived host process for an Agent to run on

### 6.4 Compression: be clever, it's cheap

**zstd over gzip** — faster at comparable ratios, and it supports **trained dictionaries.**
Stack traces and JSON keys are enormously repetitive across payloads. Ship a trained dictionary
with the SDK and a 4 KB event compresses to a few hundred bytes. On small batches this beats
gzip substantially, and it costs one `zstd --train` run over a corpus.

### 6.5 Envelope framing

**Newline-delimited, length-prefixed items** (Sentry's envelope model). The collector
stream-parses without buffering the whole body, and a **truncated payload still yields every
complete item before the tear.**

Batch flush triggers: `max_items` **OR** `max_bytes` (~512 KB) **OR** `max_delay` (~5s),
whichever fires first — plus a forced flush on shutdown / serverless freeze.

---

## 7. L3 — Backpressure in both directions

### 7.1 Downward: our API tells the SDK to slow down

The mechanism that actually protects our API. **OTel has essentially no story here.**

```http
X-BB-Sample-Directive: {"error":1.0, "log":0.02, "span":0.005}
X-BB-Suppress-Fingerprints: ["fp_a1b2c3"]     <- counts only, no exemplars, 10 min
X-BB-Retry-After: 30
X-BB-Config-Version: 42
```

The SDK **stops generating**, not just stops sending.

Note the second header — **per-fingerprint suppression.** Once we hold 50,000 samples of
`fp_a1b2c3`, we do not need the 50,001st payload; we need the *count*. Communicating that to the
edge is a large, cheap win — and it is **only possible because fingerprinting happens
client-side.**

### 7.2 Upward: protect the host when we are down

- **Hard timeouts on everything** — connect 2s, total 10s
- **Circuit breaker** — N consecutive failures → open, stop trying entirely
- **Exponential backoff with FULL JITTER** — non-negotiable. Without jitter, thousands of
  customer fleets all retry at `t+30s` and we DDoS ourselves on recovery.
  *Our own retry storm will hurt us worse than the original outage.*
- **Bounded retries** — 3 attempts, 5xx/network only, **never 4xx**. Agents that retry forever
  are how monitoring takes down production.
- **Disk spool** — default **off** in the SDK (never write to a customer's disk uninvited),
  **on** in the agent, with a hard byte cap and TTL
- **Hard memory ceiling** (~8 MB default) — cross it, drop and count

---

## 8. L3 — The ingest edge

Two rules, both about **doing less.**

### 8.1 Never parse the body

Verify the envelope header, treat the payload as **opaque bytes**, append, return `202`.

Parsing untrusted input at the front door is both the latency floor and the security surface —
decompression bombs, 200-deep nested JSON, pathological regex. Parse in the **processing tier**,
where slowness is affordable and a crash is a retry rather than an outage.

### 8.2 Shed by priority, computed at the edge

The SDK stamps a **priority byte** on the envelope so ingest can shed **without parsing.**

```text
debug logs → info logs → spans on healthy endpoints → aggregate counts
                                                            │
   NEVER SHED: first occurrence of a new fingerprint · 5xx exemplars
```

That `NEVER SHED` line is a **product** decision as much as an engineering one: the first
sighting of a novel error is the highest-information byte in the entire system. It must survive
everything.

### 8.3 The rest of the edge

- **Auth** from an in-memory cache (key → org). **Never** a DB round-trip.
- **Quota** as a Redis token bucket with a local pre-check.
- **Target p99 < 15ms**, fully stateless, horizontally scalable.

### 8.4 L4 — Storage: MongoDB, one database per organization

**Resolved (§10): MongoDB, not Postgres; no Kafka/Redpanda durable log in v1.** The ingest edge
writes directly into the org's own database — no queue in between. This is a deliberate
simplification, not an oversight: a distributed log exists to buy per-tenant isolation, buffering
under load, and replay, and at pilot scale (a few orgs, pre-prod traffic) none of those problems
are live yet. See §10's growth triggers for exactly what condition brings the log back.

**Tenant isolation, done structurally instead of by convention:**

```text
bugbuster_control        ← shared: org metadata, API key → {org_id, db_name}
bugbuster_org_<name>     ← one database per org: events, issues, deploys
bugbuster_org_<name>     ← a second org, fully separate database
...
```

The ingest edge resolves the API key to a database name *before* touching any tenant data, then
opens that connection for the rest of the request. There is no shared collection with an `org_id`
filter to forget in some future query — the isolation is enforced by which database a connection
even has a handle to, not by remembering to add a `WHERE org_id = ?` (or Mongo-equivalent
`{org_id: ...}`) everywhere. This is the practical reason it beats a shared-collection model at
this org count: a missed tenant filter is a real, common class of SaaS data leak, and this removes
the class entirely rather than relying on discipline.

This does not scale indefinitely — dozens-to-hundreds of orgs make per-database connection
management unwieldy, at which point the shared-collection-plus-`org_id`-filter model (with the
now-necessary discipline enforced by tests) is the natural next step. That migration is deferred
until the org count actually demands it (§10).

**What the durable log would still buy, once it comes back (kept for the record):**

1. **Per-tenant isolation of write *load*** (not data — the database split already isolates data)
   — one customer's storm becomes one partition's problem instead of contending for the shared
   ingest process
2. **Buffering** — processing can lag behind ingest without dropping
3. **Replay** — when the fingerprinting algorithm improves, **recompute history** instead of
   living with the old grouping forever. In v1, the raw exemplar payloads stored per-issue serve
   as a *partial* substitute — enough to re-fingerprint stored exemplars, though not to replay
   every raw event, since only exemplars (not the full stream) are persisted.

---

## 9. Does the math work?

This is the target-scale math the wire format and the fold are designed against — **not**
current load. Actual v1 traffic (a handful of pilot orgs, pre-prod) is far below this table; the
point of computing it here is to confirm the *design* holds before it's needed, per §10's
"schema built big, infrastructure built small" rule.

Mid-size customer: **500 req/s, 1% error rate → 432k errors/day.**

| Approach | Daily volume |
|---|---|
| Naive (5 KB/event) | **2.2 GB** |
| + edge fold (~50:1 — storms are bursty and repetitive) | **44 MB** |
| + zstd with trained dictionary | **~15 MB** |

That is the gap between *"unit economics work"* and *"we are an S3 bill with a dashboard."*

> Which is why **the fold is not an optimization to add later — it is the architecture** — even
> though v1's actual database has nowhere near this much data flowing through it yet.

---

## 10. Decisions — resolved

Actual scale at time of writing: **2–3 organizations, all pre-production, ~4 SDK installations
total.** The four decisions below were originally left open; each is now resolved, informed by
that number.

| # | Decision | Resolution | Reasoning |
|---|---|---|---|
| **1** | SaaS or self-hosted first? | **Multi-tenant from day one** — MongoDB, one database per org (§8.4) | Real, separate organizations exist today, and cross-org data leakage is a correctness requirement, not a future concern — isolation cannot be deferred the way quota/billing infrastructure can. Solved structurally (separate databases) rather than by convention (a shared collection plus a filter someone could forget), because at 2–3 orgs the structural version is *free* — it costs nothing extra to run three small databases instead of one. |
| **2** | First SDK language? | **Node** | Worker threads move serialization/compression/fingerprinting fully off the event loop without fighting the GIL or fork-safety — the cleanest environment to validate the fold logic in before porting to a harder language. |
| **3** | Agent in v1 or v2? | **v1 — required for every backend-hosted SDK** | Reopened from the original default (which deferred it). The Agent keeps the SDK to "write to a socket, forget" from the first release, rather than shipping a fatter direct-mode SDK now and migrating transport logic under pressure later. UDS is the SDK↔Agent hop (same host); HTTPS is the Agent↔VPS hop (§6, §4 in the glossary). |
| **4** | Scale target for v1? | **Schema and isolation designed for growth; infrastructure sized for today** | Concretely: `org_id`-equivalent isolation (database-per-org) is real now; Kafka, HyperLogLog/DDSketch, and quota enforcement are all deferred — see growth triggers below. This is the one-way-door test from §4.4/§5.2 applied consistently: schema and protocol shape are expensive to change later, so they're built for the bigger number; infra topology is cheap to change later, so it's built for the number that's actually true today. |

### What v1 actually is, concretely

```text
~4 SDK installs (Node)         Each host: App+SDK ──UDS──▶ Agent ──HTTPS──▶
                                                                              │
                                                                              ▼
                                                                    One VPS, one Node process
                                                                    (ingest edge + processing,
                                                                     not yet split into services)
                                                                              │
                                                                              ▼
                                                        MongoDB — one database per org
                                                                              │
                                                                              ▼
                                                              Query API → Dashboard
```

No Kafka. No sketches. No quota enforcement. No per-service split of fold/correlate/alert (§1 of
plate 08 in the blueprint) — those run in-process for now. What **is** built correctly from the
start: per-org database isolation, the `adjusted_count` field (§5.2), the fingerprint/fold
document shape (§4.2), and the SDK's `Transport` interface seam (so Agent-vs-direct is a
implementation swap, not a rewrite).

### Growth triggers — what brings each deferred piece back, and why it isn't a date

Each trigger is a **measurement**, not a calendar entry. Building ahead of the trigger was
evaluated and rejected — see the conversation history / commit context for the specific reasoning
(single-broker Kafka provides no real durability gain; sketches are *less* accurate than exact
counts at pilot volume; each is a cost paid for a benefit that doesn't exist yet at this scale).

| Deferred piece | Comes back when |
|---|---|
| Durable log (Kafka/Redpanda) | The single Mongo-writing process shows measured write contention, a fingerprinting-algorithm change needs full-history replay (not just stored exemplars), or a second independent consumer needs the same event stream |
| HyperLogLog / DDSketch | Exact-count aggregation queries are measurably slow, or the fold table's raw-value memory footprint is measurably large |
| Quota / rate limiting per org | One org's test traffic is measured to cause a slowdown for another org sharing the VPS |
| Shared-collection multi-tenancy (retiring database-per-org) | The org count makes per-database connection management measurably unwieldy — likely dozens, not the current 2–3 |
| Direct mode promoted to a real supported path for backend SDKs (today it's a fallback) | A concrete backend deployment target can't run a host-local Agent for a reason other than "we haven't built the installer yet" |

---

## 11. Next deep-dive (pick one before writing the build plan)

With §10 resolved, the next layer down is one of:

1. **Fold / fingerprint mechanics** — the thing that makes this project *original*:
   normalization rules, coarsening strategy, exemplar selection policy, cross-version stability.
2. **MongoDB schema & query layer** — the thing that decides what the dashboard can actually
   *ask*: the exact `events` / `issues` / `deploys` document shapes per org database, which
   fields are indexed, how the fold's `findOneAndUpdate` upserts are structured, and where the
   exact-count fields (§4.2) will later swap for sketches without a shape change.
3. **The Agent itself** — its own lifecycle now that it's in v1 scope: how it's deployed
   alongside the SDK on a host, its own crash/restart behavior, and the UDS handshake / socket
   discovery the SDK uses to find it (§6.3).

---

## Appendix A — Invariants to encode as tests

```text
SDK
  [ ] no public entry point can throw
  [ ] recursion guard prevents logger -> SDK -> logger loops
  [ ] every buffer enforces a byte cap
  [ ] survives fork()  (Python: gunicorn --preload)
  [ ] timers unref'd; process exits promptly
  [ ] shutdown flush bounded (<= 2s)
  [ ] hot path: no syscall, no JSON, no unbounded alloc
  [ ] host p99 impact measured and asserted under load
  [ ] behaves correctly when API returns 5xx / times out / is unreachable
  [ ] retries bounded, jittered, never on 4xx
  [ ] memory ceiling enforced under sustained storm

FIDELITY
  [ ] every drop is counted and reported
  [ ] every stored record carries adjusted_count
  [ ] dashboard never displays a sampled count as absolute truth

EDGE
  [ ] ingest never parses a payload body
  [ ] shedding respects priority order
  [ ] new-fingerprint and 5xx exemplars are never shed
  [ ] one tenant's storm cannot degrade another tenant
```

---

## Appendix B — Glossary

| Term | Meaning |
|---|---|
| **Fold** | Collapsing many identical-fingerprint events into one counted aggregate + a few exemplars, *before* transmission |
| **Exemplar** | A full-fidelity event payload retained as a representative of a folded group |
| **Fingerprint** | Stable hash identifying "the same bug" — computed client-side in BugBuster |
| **adjusted_count** | The sampling weight; multiplier that recovers the true population count |
| **Fidelity** | How much of the true signal actually survived capture, sampling, and shedding |
| **Direct mode** | SDK talks straight to the ingest API over HTTPS, no Agent — the v1 fallback for browser/mobile/serverless, not the default for backend services |
| **Agent mode** | SDK talks to a host-local Agent over a Unix domain socket, which then talks HTTPS to the VPS — **required in v1** for every backend-hosted SDK (§6) |
| **Coarsening** | Deliberately weakening the fingerprint (stripping frames) to cap cardinality |
