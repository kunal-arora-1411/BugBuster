# BugBuster

An error-first observability platform. Unlike OpenTelemetry — which treats grouping as a backend
concern — BugBuster fingerprints and folds duplicate errors **client-side, in the SDK**, before
they ever touch the network. A 50,000-event error storm becomes a handful of aggregate records
plus a few full-fidelity exemplars, computed where the storm is happening, not after it's already
cost you the bandwidth.

This is a real distributed-systems project: the goal is engineering rigor at every layer, even
though current scale is intentionally small (a few pilot organizations, pre-production).

## Why it's built this way

Read these before touching the code — they're the reasoning behind every design choice below,
not background color:

- **[`docs/architecture/ingest-pipeline.md`](docs/architecture/ingest-pipeline.md)** — the full
  design: the hot-path budget, the fold, sampling, the Agent, backpressure, the ingest edge, and
  §10's resolved decisions + growth triggers (what's deferred, and the measurement that brings
  each piece back).
- **[`docs/architecture/bugbuster-blueprint.html`](docs/architecture/bugbuster-blueprint.html)** —
  the same architecture as eight drawn plates. Open it in a browser.
- **[`docs/glossary.md`](docs/glossary.md)** — plain-English explanations of every term used above
  (p99, ring buffer, UDS, cardinality, sketches, circuit breakers...). Start here if any of that
  is unfamiliar.

## Repo map

One monorepo, package-per-architectural-component — reading `packages/` top to bottom is reading
the architecture diagram:

| Package | Role |
|---|---|
| [`packages/types`](packages/types) | The wire-format contract — envelope, event, issue, and header shapes shared by every other package. Change something here and the type-checker tells every consumer immediately. |
| [`packages/sdk-node`](packages/sdk-node) | The instrumentation SDK. Lives inside a customer's Node process; owns the hot path (<5µs budget), fingerprinting, and the in-process fold. |
| [`packages/agent`](packages/agent) | The required host-local daemon (v1). SDK talks to it over a Unix domain socket; it's the only thing that makes the network hop to the backend. |
| [`packages/backend`](packages/backend) | Ingest edge + processing + Query API. Resolves each request to its organization's own MongoDB database before touching any data. |
| [`packages/dashboard`](packages/dashboard) | Minimal read-only issue viewer against the Query API — no build step, single HTML file. |
| [`examples/demo-app`](examples/demo-app) | A small Express app instrumented with `sdk-node`, plus the genuine end-to-end test wiring every component together for real. |

## Getting started

```bash
pnpm install
docker compose -f infra/docker-compose.yml up -d   # local MongoDB
pnpm build
pnpm test:unit
```

For the full local run-through (Agent, backend, demo app, dashboard, all wired together against
real MongoDB), see [`docs/runbook.md`](docs/runbook.md). For the API surface, see
[`docs/api.md`](docs/api.md); for the MongoDB schema, [`docs/schema.md`](docs/schema.md).

## Status

Architecture resolved and implemented end-to-end: every package above is built and tested,
including a genuine cross-component integration test
(`examples/demo-app/test/full-pipeline.test.ts`) exercising a real SDK → real Agent (over a real
Unix domain socket) → real backend (over real HTTP, real zstd compression) → real MongoDB → real
Query API. That test caught four real bugs no single package's own tests could have found alone —
see `examples/demo-app/README.md` for what they were and why isolated testing missed them.

```bash
pnpm test:unit          # every package's unit tests — no external services needed
pnpm --filter @bugbuster/backend test:integration   # real MongoDB via mongodb-memory-server
pnpm --filter @bugbuster/demo-app test:integration  # the full end-to-end pipeline
```

What's deliberately not built yet, and why, is tracked in
[`docs/architecture/ingest-pipeline.md`](docs/architecture/ingest-pipeline.md) §10's growth
triggers — each is a measurement, not a date.
