# BugBuster — Terminology & Concepts

> **Purpose:** plain-English explanations of every term used in
> `architecture/ingest-pipeline.md`. Written to be read cold, in order, or dipped into.
> Most of this is standard industry vocabulary; §9 is vocabulary we coined for this project.

**Contents**

1. [Time units — µs, ms, ns](#1-time-units--µs-ms-ns)
2. [Percentiles — p50, p95, p99](#2-percentiles--p50-p95-p99)
3. [Ring buffer](#3-ring-buffer-aka-circular-buffer)
4. [UDS — Unix Domain Socket](#4-uds--unix-domain-socket)
5. [HTTP status codes, and why they drive behaviour](#5-http-status-codes-and-why-they-drive-behaviour)
6. [Flow control — backpressure, circuit breaker, backoff, shedding](#6-flow-control-vocabulary)
7. [Hot path, syscalls, fork-safety, context storage](#7-hot-path-syscalls-and-friends)
8. [Data shape — cardinality, sketches, traces, sampling](#8-data-shape-vocabulary)
9. [Our own coined vocabulary](#9-our-own-coined-vocabulary)
10. [Infrastructure terms](#10-infrastructure-terms)

---

## 1. Time units — µs, ms, ns

```text
1 second (s)
  = 1,000 milliseconds (ms)
  = 1,000,000 microseconds (µs)   <- "µ" is the Greek letter mu
  = 1,000,000,000 nanoseconds (ns)
```

So **5µs = 5 millionths of a second.**

Rule of thumb for which unit to use:

- **µs** is the natural unit for *work happening inside one process*
- **ms** is the natural unit for *work that crossed a network*

### The latency ladder

Learn the *shape* of this, not the exact numbers.

| Operation | Rough cost |
|---|---|
| One CPU instruction | 0.3 ns |
| Read from L1 cache | 1 ns |
| Read from RAM | 100 ns |
| Read a value from `AsyncLocalStorage` | ~200–500 ns |
| `JSON.stringify` a small object | 1–10 µs |
| **V8 formatting a stack trace** | **10–50 µs** |
| Write to a Unix domain socket | 10–50 µs |
| Read from an SSD | ~100 µs |
| Network round trip, same datacenter | ~500 µs (0.5 ms) |
| **TLS handshake** | **1–3 ms** |
| Network round trip, US → Europe | ~150 ms |

### Intuition trick: multiply everything by a billion

Pretend 1 ns = 1 second. Then:

```text
CPU instruction  ->  0.3 seconds
RAM access       ->  1.5 minutes
SSD read         ->  1 day
Same-DC network  ->  6 days
TLS handshake    ->  1 month
US -> Europe     ->  5 years
```

This is why "no syscalls, no JSON on the hot path" matters. Formatting a stack trace is not slow
in human terms — but *relative to the work around it*, it is taking a day off.

---

## 2. Percentiles — p50, p95, p99

**The single most important concept in the architecture doc.**

Take every request served in the last hour and **sort them by duration.** Then:

| Percentile | Meaning |
|---|---|
| **p50** | The middle one. Half faster, half slower. (Also called the **median**.) |
| **p95** | 95% were faster. 1 in 20 was slower. |
| **p99** | 99% were faster. **1 in 100 was slower.** |
| **p99.9** | 999 in 1,000 were faster. 1 in 1,000 was slower. |

> **"p99 = 3ms"** means: *99% of requests finished in under 3ms.*

### Why we never use averages

```text
100 requests:
   99 requests took   10 ms
    1 request  took 5000 ms

Average = (99 x 10 + 5000) / 100 = 60 ms      <- looks basically fine
p50     = 10 ms                               <- looks great
p99     = 5000 ms                             <- the truth
```

The average **hid a five-second outage** for one user. One slow request drags the mean up only
slightly; percentiles show *the actual worst experience real people had.*

> This is why the industry moved to percentiles: **the average is the number that lets you not
> notice your product is broken.**

The high percentiles are collectively called the **tail** (the far right of the distribution
curve). "Tail latency" = how bad your slow cases are.

### Why "3ms at p99" is scarier than it sounds

Two amplification effects:

**(a) Page loads make many calls.** If one API call has a 1% chance of hitting the slow tail,
and loading a page makes 20 calls:

```text
P(at least one slow call) = 1 - 0.99^20 = 18%
```

Almost **1 in 5 page loads** touches the tail, even though only 1 in 100 *calls* does.

**(b) Microservices chain.** A request passing through 10 services, each with its own p99
overhead:

```text
P(hitting the tail somewhere) = 1 - 0.99^10 = 10%
```

So *"we add 3ms p99 to their checkout and they rip us out"* is really about this:
**our tail becomes their tail, multiplied by how many times our code runs per user action.**

---

## 3. Ring buffer (a.k.a. circular buffer)

### The problem it solves

The obvious way to queue events is a list you append to:

```javascript
events.push(evt)   // simple... and a time bomb
```

Under an error storm that list grows: 10k events, 100k, 1M — and **the host's process runs out
of memory and crashes.** Our monitoring tool just killed their app. This is the exact failure we
must never have.

### The fix: a fixed-size array that wraps around

Allocated once at startup — say 4,096 slots — and it never grows.

```text
        write ptr v
   ┌───┬───┬───┬───┬───┬───┬───┬───┐
   │ E │ F │ G │   │   │ A │ B │ C │     capacity = 8, fixed forever
   └───┴───┴───┴───┴───┴───┴───┴───┘
                     ^ read ptr

   Writer advances the write pointer, wrapping 7 -> 0.
   Reader (the flush worker) advances the read pointer behind it.
   The "circle" is just index arithmetic:  next = (i + 1) % capacity
```

### Why it is the right structure for a hot path

| Property | Why it matters here |
|---|---|
| **Memory allocated once** | Cannot leak. Cannot OOM the host. The 8 MB ceiling is real, not aspirational. |
| **No allocation per event** | No garbage for the GC to collect. In Node/Java/Go, allocation churn causes GC pauses — which surface as *the host's* p99 spikes. |
| **O(1), just an index bump** | ~20 ns. Nothing to search, resize, or copy. |
| **Overflow is a policy, not a crash** | When full you choose: drop the new event, or overwrite the oldest. Either way you **stay alive and increment a counter.** |

That last row is the whole philosophy:

> **A bounded buffer converts an unbounded risk (crash) into a bounded cost
> (some lost data, honestly reported).**

### "Lock-free"

A **lock** (mutex) is how two threads avoid stepping on each other — but acquiring one can make a
thread *wait*, which is unacceptable on a hot path. With exactly one writer and one reader, you
can coordinate using only atomic integer operations and never wait. That is **lock-free.**

---

## 4. UDS — Unix Domain Socket

A socket is a two-way pipe between programs. Two flavours:

```text
NETWORK SOCKET (TCP)                    UNIX DOMAIN SOCKET
addressed by  IP + port                 addressed by a FILE PATH
  api.bugbuster.io:443                    /var/run/bugbuster.sock

  your app                                your app
     |                                       |
     v                                       v
  TCP stack (handshake, seq numbers,       kernel copies bytes
  checksums, retransmit, congestion)         from buffer A -> buffer B
     |                                       |
     v                                       v
  network card -> router -> internet      the agent (same machine)
     |
     v
  the other machine

  ~500 µs same-DC, +1-3 ms for TLS        ~10-50 µs
```

A UDS **only works between processes on the same machine.** That restriction is exactly what
makes it cheap — the kernel skips the entire networking stack and just copies bytes between two
memory buffers. No handshake, no packets, no checksums, no routing.

### And critically: no TLS

TLS (the "S" in HTTPS) is encryption that protects data *while it travels across a network
someone could eavesdrop on.* Data going through a UDS never leaves the machine, so there is
nothing to protect against — encrypting it would be pure cost.

Authentication is handled by **file permissions** instead: the socket *is* a file, so the OS
already decides who may open it.

### Why this makes the Agent so valuable

| | Direct mode (SDK -> our API) | Agent mode (SDK -> UDS) |
|---|---|---|
| TLS handshake | in the customer's process | none |
| Certificate validation | in the customer's process | none |
| Compression | in the customer's process | none |
| Retries / circuit breaker | in the customer's process | none |
| Connection pooling | in the customer's process | none |
| **SDK's total job** | all of the above | **one ~30 µs write, then forget** |

All the expensive, failure-prone machinery moves into **our** process on the same machine.

> **Windows note:** the traditional equivalent is a **named pipe** (`\\.\pipe\bugbuster`).
> Windows 10+ does also support real AF_UNIX sockets, so cross-platform is achievable — but it
> is a genuine portability work item, not a footnote.

---

## 5. HTTP status codes, and why they drive behaviour

| Code | Class | Meaning | Retry? |
|---|---|---|---|
| `200 OK` | 2xx success | Done, here is your result | n/a |
| **`202 Accepted`** | 2xx success | **"I've taken your data. I haven't processed it yet."** | n/a |
| `400 Bad Request` | **4xx = client's fault** | Your payload is malformed | **Never** |
| `401` / `403` | 4xx | Bad or unauthorized API key | **Never** |
| `413 Too Large` | 4xx | Payload exceeds limit | **Never** |
| `429 Too Many Requests` | 4xx | Rate limited — slow down | Only after `Retry-After` |
| `500 Internal Error` | **5xx = our fault** | We broke | **Yes** |
| `503 Unavailable` | 5xx | We are overloaded or restarting | **Yes** |

### Why `202` is the key one for ingest

`200` implies *"I did the work."* `202` means *"I durably accepted this; processing happens
later."* That is exactly the contract we want — it is what allows the ingest edge to
append-and-return in under 15ms **without parsing anything.**

### Why the 4xx / 5xx retry rule matters enormously

- A **4xx** means *the request itself is wrong.* Sending it again produces the identical
  failure, forever, burning the host's CPU and our capacity.
- A **5xx** means *we* failed, and the same request might succeed in 10 seconds.

> Retrying 4xx is one of the classic ways a monitoring agent becomes the outage.

---

## 6. Flow control vocabulary

### Backpressure

Borrowed from plumbing. When a downstream stage cannot keep up, it **pushes back** on the
upstream stage to slow it down. Without backpressure, work piles up in a queue until memory runs
out. With it, the producer simply produces less.

In our design it runs both directions:

- our API tells the SDK to **generate** less
- the SDK stops trying when our API is unhealthy

### Circuit breaker

Named after the electrical kind, and it works the same way — it *trips* to protect the system.

```text
CLOSED  ---- 5 consecutive failures ---->  OPEN
  ^                                         |
  |                                         | wait 30s
  |  success                                v
  +--------------------------------  HALF-OPEN
                                  (let ONE request through and see)
```

- **CLOSED** — normal, traffic flows
- **OPEN** — stop trying *entirely.* Fail instantly without even attempting the network.
- **HALF-OPEN** — after a cooldown, allow a single probe request to test recovery

The point: if our API is down, attempting a connection *per event* wastes the host's threads and
sockets on something guaranteed to fail. Failing instantly is nearly free.

> **Give up fast, and count what you dropped.**

### Exponential backoff + jitter

**Backoff** = each retry waits longer: 1s → 2s → 4s → 8s. Stops you hammering a server that is
already struggling.

**Jitter** = adding randomness to those delays. Sounds like a detail; is actually critical.

```text
WITHOUT JITTER                          WITH FULL JITTER
5,000 client fleets all fail at t=0     each picks a random delay in [0, ceiling]

t+1s  ############## all 5,000 retry    t+0..1s  .:.'.:'.:. spread out
      -> server dies again                       -> server absorbs it
t+2s  ############## all 5,000 retry
      -> server dies again
```

That synchronised wave is a **thundering herd**, and it is self-inflicted: your recovery attempt
becomes a DDoS on yourself. **"Full jitter"** means picking uniformly at random between 0 and the
current backoff ceiling, rather than adding a small wobble.

### Load shedding

Deliberately **throwing away work when overloaded**, instead of accepting everything and
collapsing. Counterintuitive but essential: serving 90% of requests well beats serving 100%
badly, and *far* beats falling over and serving 0%.

The skill is in *choosing what to drop* — which is what the priority ordering in
`ingest-pipeline.md` §8.2 exists for.

---

## 7. Hot path, syscalls, and friends

### Hot path

Code that runs on **every single request.** Contrast with the **cold path** — startup, config
reload, error handling that fires once an hour.

Optimisation effort only pays off on the hot path; a 100 µs improvement to startup is worth
nothing.

### Syscall (system call)

A call into the **OS kernel**: writing a file, sending on a socket, reading the clock. Costs
~100 ns–1 µs *plus* a context switch (the CPU swaps out of your program into the kernel and
back). Worse, many syscalls can **block** — put your thread to sleep until the OS is ready.

> "Zero syscalls on the hot path" = never touch the OS while the user's request is waiting on us.

### Fork-safe

`fork()` is the Unix way to create a new process: the OS **copies** the current one. Production
Python/Ruby web servers (gunicorn, uWSGI, Puma) fork worker processes to use all CPU cores.

**The trap: threads do not survive `fork()`.** The child gets a copy of all the *memory* but only
*one* thread — the one that called fork.

```text
parent:  [ring buffer]  +  [flush thread running]  OK
   | fork()
   v
child:   [ring buffer]  +  [NO flush thread]       BROKEN

-> buffer fills -> everything drops -> zero telemetry, silently, forever
```

Being "fork-safe" means detecting this (`os.register_at_fork` in Python) and re-creating the
thread in the child. This is a *guaranteed* bug if not designed for, and brutal to debug because
it only appears in production configurations.

### GIL (Global Interpreter Lock)

Python's rule that **only one thread may execute Python bytecode at a time.** So spawning a
background thread in Python does not buy a free extra CPU — it time-shares with the app's
threads.

That is why Python "makes the agent nearly mandatory": you cannot hide the work in a thread the
way Node can hide it in a worker.

### AsyncLocalStorage / contextvars / ThreadLocal

All solve the same problem: **"which request am I currently part of?"** without threading a
parameter through 50 layers of function calls.

```javascript
// Without it - you must pass ctx everywhere, forever:
handleOrder(ctx, req) -> validate(ctx, x) -> charge(ctx, y) -> log(ctx, z)

// With it - ambient, invisible:
store.run({ traceId }, () => handleOrder(req))
// ...50 frames deep, with no parameter passing:
store.getStore().traceId
```

Per language:

| Language | Mechanism | Note |
|---|---|---|
| Node | `AsyncLocalStorage` | follows the value across `await` |
| Python | `contextvars` | works with asyncio |
| Java | `ThreadLocal` / Scope | |
| Go | explicit `context.Context` | Go refuses to make it implicit |

> **This is the mechanism that makes distributed tracing possible** — it is how a `trace_id` set
> at the edge of a request is still findable deep inside the code.

### Unref'd timer

In Node, a pending timer **keeps the process alive** — Node will not exit while something is
scheduled. Calling `.unref()` says "do not count me as a reason to stay open."

Without it, our 5-second flush timer would prevent a customer's CLI tool or script from ever
exiting. Tiny detail; extremely visible bug.

---

## 8. Data shape vocabulary

### Cardinality

**The number of distinct values a field can take.**

```text
LOW cardinality                     HIGH cardinality
http_status   ~50 values            user_id       10,000,000 values
country       ~200                  request_id    unbounded
service_name  ~30                   session_id    unbounded
```

Why it dominates observability design: databases index distinct values, and grouping requires
holding one entry *per distinct combination* in memory. Add `user_id` as a tag and 30 services ×
50 statuses (1,500 groups) becomes 15 **billion** groups. That is a **cardinality explosion** —
the number one way observability systems fall over.

Note the asymmetry:

> **Volume you can compress and sample. Cardinality you cannot** — every distinct value is
> genuinely new information that needs its own slot.

### Sketches (probabilistic data structures)

Structures that give an **approximate** answer in **tiny, fixed** memory. The trade is
*"1% error for 10,000x less memory"* — almost always the right trade for a dashboard.

**HyperLogLog (HLL)** — counts *distinct* items.

- Exact: counting 10M unique users means remembering all 10M IDs → hundreds of MB
- HLL: **~16 KB, ~1% error**
- The trick: hash each item and track the longest run of leading zeros seen. A hash with 20
  leading zeros is unlikely unless you have observed roughly 2^20 distinct items — so the
  *rarity of the pattern reveals the count.* You store the pattern, not the items.

**Mergeable** — the property that makes this work for us. Two HLLs built on different pods can be
combined into one HLL correct for the *union*, **automatically deduplicating users who appeared
on both.** Plain counters cannot do this: adding pod A's 100 users to pod B's 100 users gives
200, even if they are the same 100 people.

**DDSketch / t-digest** — approximate **percentiles** in fixed memory. An exact p99 requires
sorting every value, which means storing every value. These bucket values cleverly instead.

We chose DDSketch because it guarantees *relative* error (±1% of the value), which keeps the tail
accurate — t-digest's guarantees are weaker exactly where p99 lives. Also mergeable.

**Space-Saving** — finds the **top-K most frequent** items in fixed memory ("which 20 endpoints
threw this error most"), discarding the long tail into an `other` bucket.

### Trace / Span / trace_id

```text
TRACE = one request's entire journey across all services
SPAN  = one operation within it

trace_id: 7f92ab...     <- the same value in every service

  |-- span: API Gateway          120ms
  |    |-- span: Auth Service     15ms
  |         |-- span: Order        80ms
  |              |-- span: Postgres query   12ms
  |              |-- span: Payment API      65ms   <- the actual culprit
```

Think of it as **a call stack that spans machines.** Each span records:

- `trace_id` — which request
- `span_id` — which operation
- `parent_span_id` — who called me

Three fields are enough to reconstruct the whole tree, even though the pieces arrive from
different servers at different times.

### Head vs tail sampling

```text
HEAD: decide at the START           TAIL: decide at the END
  | request arrives                   | request arrives
  flip a coin: keep? 1%               keep EVERYTHING provisionally
  |                                   | request finishes
  cheap - but you decided             errored or slow? -> KEEP
  before knowing it errored           boring success?  -> DROP
                                      |
                                      correct - but you had to hold
                                      spans from many machines somewhere
```

Our compromise (`ingest-pipeline.md` §5.1): hold spans **only within the one process** until that
process's part of the request finishes. You get the "did it error?" signal for free and locally,
without the distributed buffering that makes true tail sampling hard.

---

## 9. Our own coined vocabulary

Not industry standard — invented for this project, which is why they need pinning down.

| Term | Meaning |
|---|---|
| **Fold** | Collapsing many same-fingerprint events into one counted aggregate + a few full samples, **before** sending |
| **Exemplar** | One full-fidelity event kept as the representative of a folded group — *"here is what one of those 50,000 actually looked like"* |
| **Fingerprint** | Stable hash meaning "this is the same bug." Computed in the SDK, which is our differentiator |
| **`adjusted_count`** | The sampling weight. Sampled 1-in-20 → weight 20 → 2,500 samples means ~50,000 real events. Storing this keeps the dashboard honest |
| **Fidelity** | How much of the true signal survived capture + sampling + shedding. *"You are seeing 12% of your errors."* |
| **Coarsening** | Deliberately *weakening* a fingerprint (dropping stack frames) so more things collide, to cap cardinality under pressure |
| **Direct mode** | SDK talks to our API itself |
| **Agent mode** | SDK talks to a node-local agent over UDS |

---

## 10. Infrastructure terms

| Term | Plain English |
|---|---|
| **Durable log** (Kafka, Redpanda) | An append-only file you can **replay.** Unlike a queue, reading does not consume — so you can reprocess history after fixing a bug in your processing code |
| **Partition** | A shard of that log. Order is guaranteed *within* a partition. Partitioning by `org_id` means one customer's flood occupies one partition instead of everyone's |
| **Multi-tenancy** | Many customers sharing one set of servers |
| **Noisy neighbour** | One tenant's load degrading everyone else's experience — the thing quotas exist to prevent |
| **Token bucket** | Rate limiter: a bucket refills at N tokens/sec, each request spends one, empty bucket = rejected. Allows short bursts while capping the sustained rate |
| **Sidecar** | An extra container running *beside* your app in the same Kubernetes pod |
| **DaemonSet** | Exactly one copy per machine in the cluster — the natural shape for our agent |
| **Stateless** | Holds no data between requests, so servers can be added/removed/killed freely. Why the ingest edge must be stateless: scaling it up mid-storm has to be trivial |
| **zstd / gzip** | Compression algorithms. zstd is newer and faster at similar ratios |
| **Trained dictionary** | A precomputed sample of typical data that both sides already hold. Instead of transmitting `"TypeError: Cannot read property"`, you transmit *"dictionary entry #4,182."* Works only if both ends share the dictionary — fine, since we ship both ends. Especially powerful on **small** payloads, where normal compression has no room to learn patterns |

---

## Appendix — the one concept worth over-learning

**Percentiles (§2).**

Every performance decision in this project is really a statement about the *tail* of a
distribution:

- "< 5µs on the hot path" — a claim about our p99, not our average
- "p99 < 15ms at the ingest edge" — the promise that makes `202`-and-append viable
- "3ms p99 and they rip us out" — the tail-amplification math
- DDSketch over t-digest — chosen *specifically* for accuracy in the tail

If averages still feel more intuitive than percentiles, that intuition will quietly mislead every
tradeoff in the build plan. Worth working one example by hand — take 20 request timings, sort
them, and read off p50 / p95 / p99 — because doing it once makes it permanent in a way reading
about it does not.
