# @bugbuster/sdk-node

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
import { init } from "@bugbuster/sdk-node";

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
