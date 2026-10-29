# @bugbusterhq/sdk-node

The instrumentation SDK. Lives inside a customer's Node process — see
[`docs/architecture/ingest-pipeline.md`](../../docs/architecture/ingest-pipeline.md) §3 (the hot
path), §4 (the fold), and blueprint plate 02 for the full reasoning behind every design choice
below.

## What it does

```
capture() -> recursion guard -> sampler -> ring buffer claim     [the hot path, <5µs/<50µs budget]
                                                ↓
                          (deferred) parse stack -> redact -> fingerprint -> fold -> serialize
                                                ↓
                                            Transport
```

## Public API

```ts
import { init } from "@bugbusterhq/sdk-node";

const client = init({
  project: "hostel-os",
  apiKey: "sk_live_...",
  environment: "production",
});

client.captureException(error);
client.captureMessage("something worth knowing, not an error");

// on shutdown — flush is bounded, never delays a deploy:
await client.shutdown();
```

## Logs

Normal application logs — not just errors — stored line by line and searchable in the dashboard:

```ts
client.log.info("order placed", { orderId: "o_1042", total: 129.5 });
client.log.warn("slow query", { table: "invoices", durationMs: 2431 });
client.log.error("payment failed", { reason: err.message });   // also: client.log.debug(...)
```

Unlike exceptions, a log is **never fingerprinted or folded** — `"user logged in"` ten thousand
times is ten thousand lines, because the line is the record. What logs share with the error path:
the same hot path (never blocks, never throws, drop-and-count), the same redaction, the same Agent
hop, and the same **trace id** — so a log written during a request carries the id of that request,
and the dashboard can jump from an error's example to every line that request wrote.

| Behaviour | Detail |
|---|---|
| `minLogLevel` | Default `"info"`. Lower levels are discarded at the very top of the hot path (one integer compare), so `debug` calls are free in production. |
| Separate buffer | Logs have their own byte-capped ring (`logBufferBytes`, default 4 MB). A burst of `info` lines can never evict an exception. |
| Redaction | Messages get the pattern scrub (emails, bearer tokens, card-like numbers). `fields` are additionally redacted **by key name** (`password`, `token`, `secret`, `authorization`, `apiKey`, `cookie`, ...) at any depth. |
| Bounded `fields` | Depth 4, 50 keys/object, 50 array items, 1 KB strings, 16 KB total; circular refs, `BigInt`, `Error`, `Date`, `Map`/`Set` and throwing getters are handled and never throw. |
| Batching | A flush window is split into batches under `flushMaxBatchBytes` so one busy window can't exceed the backend's request limit; the error path always rides the first batch. |
| Sampling | The backend's per-type `log` sample rate is obeyed independently of errors. |
| Mutation | `fields` is shallow-copied at call time; nested objects are read at flush time (within ~5 s), so don't mutate them after logging. |

### Logs from Express

```ts
const bb = createExpressIntegration(client, {
  logRequests: { ignorePaths: ["/healthz"] },   // one access-log line per request
});
app.use(bb.requestHandler);                      // mount first
bb.instrumentConsole({ logs: true });            // also ship console.log/info/debug/warn/error
bb.log.info("order placed", { orderId });        // same API as client.log, trace-aware
```

Both are **opt-in** because they decide how much of what your app prints leaves the process.
`logRequests` writes `GET /orders/42 200 12ms` with `{ method, path, route, status, durationMs,
requestId }` — 2xx/3xx at `info`, 4xx `warn`, 5xx `error`; **query strings are never logged**.
`instrumentConsole({ logs: true })` is in addition to (not instead of) the existing exception capture
from `console.error` / `console.warn`, and always still calls the original console method.

### Already using pino or winston?

```ts
import { createLogStream } from "@bugbusterhq/sdk-node";

const logger = pino(createLogStream(client));                       // pino: any writable works as a destination
const logger = winston.createLogger({                               // winston: via its Stream transport
  format: winston.format.json(),
  transports: [new winston.transports.Stream({ stream: createLogStream(client) })],
});
```

No changes to your existing `logger.info(...)` calls. It understands both shapes (pino's numeric
`level` and `msg`, winston's string `level` and `message`); everything else on the line becomes
`fields`. Cost note: it `JSON.parse`s each line in the logger's call stack — the price of accepting
an already-serialized line; `client.log.*` avoids it.

## Framework integrations

Auto-instrumentation for Express (or any Connect-style `(req, res, next)` framework), so a host
application doesn't have to hand-roll console interception, trace context, and a
never-silently-lose-a-5xx safety net per integration:

```ts
import { init, createExpressIntegration } from "@bugbusterhq/sdk-node";

const client = init({ project: "my-app", apiKey: "sk_live_...", environment: "production" });
const bb = createExpressIntegration(client);

bb.instrumentConsole();      // console.error(Error) / console.warn(Error | string) auto-captured
app.use(bb.requestHandler);  // mount before routes — propagates trace context per request

// in your own catch blocks / error middleware:
bb.captureException(err);
bb.captureMessage("something worth knowing, not an error");
```

`bb.requestHandler` synthesizes a `HandledHttpError` for any 5xx response that nothing else
already reported — but never a duplicate if `bb.captureException`/`bb.captureMessage` (or
`instrumentConsole`'s console hooks) already captured something during that same request. The
core `captureException` also dedupes the same `Error` *object* captured twice (e.g. via a console
hook and a manual call for the same thrown error) — one occurrence, not two.

## Transport: Agent mode is the production path, not HttpTransport

Per ingest-pipeline.md §6.3, `init()` probes `agentSocketPath` (default
`/var/run/bugbuster/agent.sock`) once at startup and prefers `UdsTransport` whenever an Agent is
actually listening there — that's the required v1 path for backend services. `HttpTransport` is
used only when no Agent is found, which is correct for two cases:

1. The documented fallback for browser/mobile/serverless SDKs, where no host-local Agent can run.
2. A dev/test convenience before an Agent is deployed on a given host.

**Known v1 gap:** the SDK↔Agent protocol is one-way — the SDK writes a batch and the Agent closes
the connection once received, with no response channel. `UdsTransport.send()` always resolves with
`directives: undefined`, so an SDK running behind an Agent does not yet obey backend sampling/
suppression directives the way direct mode does. See `src/transport/uds-transport.ts`'s doc
comment for what a real fix needs (the Agent pushing directives down, or the SDK pulling them on
its next connection) — not built speculatively, flagged instead.

## Known v1 simplifications

Two implementation choices trade a small amount of architectural purity for schedule, without
changing any tested behavior:

- **The "worker" pipeline (stack parse → redact → fingerprint → fold → serialize) runs deferred
  on the same thread, not inside a real `node:worker_threads` Worker.** The architecture doc calls
  for a worker thread; what actually matters for the hot-path budget is that this work never runs
  *synchronously inside the request's own call stack* — which holds true here, since it's deferred
  to the periodic flush timer. True OS-thread parallelism (and the message-passing/structured-clone
  work that requires) is a fast-follow, not a correctness requirement at pilot scale.
- **`HttpTransport` has no separate connect-phase timeout** — `fetch`'s `AbortController` only
  gives one total-request timeout, so `connectTimeoutMs` is accepted but not independently
  enforced yet.

## Testing

```bash
pnpm test        # unit tests
pnpm bench       # hot-path timing — indicative, not a portable SLA (machine-dependent)
```
