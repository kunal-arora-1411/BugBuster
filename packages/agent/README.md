# @bugbuster/agent

The required host-local daemon (v1) — see
[`docs/architecture/ingest-pipeline.md`](../../docs/architecture/ingest-pipeline.md) §6 and
blueprint plates 01/04/05B. Every backend-hosted SDK on a host talks to the one Agent running
there over a Unix domain socket; the Agent is the only thing that makes the network hop out.

## What it owns that the SDK deliberately doesn't

```
SDK(s) on this host --UDS--> UdsServer --merge--> AgentHttpClient --HTTPS--> backend
                                            |
                                     cross-process fold
                                     (the Agent's reason to exist)
```

- **Cross-process folding** (`merge-fold-deltas.ts`) — combines same-fingerprint deltas from every
  service on the host before the one outbound request, preserving the highest priority seen for
  each fingerprint so a "never-shed" signal from any one service survives the merge.
- **TLS, retries, the circuit breaker** (`http-client.ts`, `circuit-breaker.ts`) — bounded jittered
  retries (5xx/network only, never 4xx), and a CLOSED/OPEN/HALF-OPEN breaker so a dead backend is
  failed against instantly rather than attempted per batch.
- **Compression** — plain zstd via Node's native `node:zlib` (no external dependency, no trained
  dictionary yet — see the implementation plan's toolchain notes on why).
- **Disk spool** (`spool.ts`) — batches that failed to send survive an Agent restart, bounded by a
  byte cap and TTL.

## Known v1 simplifications

- **One Agent serves one organization.** `AgentConfig.apiKey` is a single key, not per-connection —
  fine because a host's services all belong to one org at pilot scale (§10's growth triggers).
- **`FoldDelta.release` merges by "first seen," not as a set** — a fingerprint spanning a deploy
  boundary within one flush window keeps only one release's identity. Rare enough at pilot volume
  to not matter; the persisted issue's release history is built from many deltas over time, not
  from this one merge step.
- **The disk spool has no dedicated automated test yet** — exercised implicitly through the
  `UdsServer.flush()` failure path, but not covered by its own test file. Not one of the invariants
  the implementation plan named as blocking; a reasonable next addition.

## Testing

```bash
pnpm test
```

The cross-process fold merge test in `test/unit/uds-server.test.ts` runs over a real local
Unix domain socket (or Windows named pipe, transparently) — not a mock.
