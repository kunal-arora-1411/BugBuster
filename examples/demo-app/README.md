# @bugbusterhq/demo-app

Two things live here:

1. **`src/app.ts` + `src/index.ts`** — a tiny Express app instrumented with `@bugbusterhq/sdk-node`
   (errors, structured logs, request logging, console capture), for manual testing against a real
   Agent + backend + MongoDB. Try `/orders/42` (normal logs), `/checkout` (fails — an error whose
   example links to the request's log lines), `/throw`, `/throw-slow`. See
   [`docs/runbook.md`](../../docs/runbook.md) for how to run the whole stack.
2. **`test/full-pipeline.test.ts`** — the genuine end-to-end proof: a real `@bugbusterhq/sdk-node`
   client, a real `@bugbusterhq/agent` `UdsServer`, a real `@bugbusterhq/backend` Fastify instance, and
   a real MongoDB (via `mongodb-memory-server`), wired together in one test. Every component is
   the actual production class — only the "separate OS process" boundary is collapsed, which
   doesn't change any wire protocol being exercised.

3. **`test/logs-pipeline.test.ts`** — the same end-to-end proof for logs, with a real Express app
   receiving real HTTP requests. Its centerpiece is the loop the feature exists for: a request
   fails, its issue's example carries a trace id, and that trace id retrieves every log line the
   request wrote. It also asserts the things only a whole-pipeline test can: no query string or
   secret reaches MongoDB (it scans the raw stored documents), lines written in the same
   millisecond return in true write order, and `console.log` still prints when captured.

## What the log tests caught

Running the log path for real, rather than trusting each package's isolated tests, again found things
no single suite would:

1. **Same-millisecond lines came back scrambled** — a debug/info/warn/error sequence logged back to
   back returned in arbitrary order, because the tiebreaker was a random UUID. Found on the real
   multi-process stack, fixed with a time-sortable `logId` (`packages/sdk-node/src/worker/log.ts`).
2. **An empty "✕" chip rendered on the Logs toolbar** — an author `display` rule beat the HTML
   `hidden` attribute. Found by actually looking at the page in a browser.
3. **Opening the dashboard directly at `#logs` and switching to Issues showed an empty table** —
   issues were only loaded for the first view shown. Also found in the browser.

## What this test caught

Running the full chain for real, rather than trusting each component's isolated tests, surfaced
four bugs that no single package's test suite could have found on its own:

1. **Missing `endpointCounts` on fresh documents** (`packages/backend/src/db/collections/issues.ts`) —
   an empty delta touches no `$inc` path under that field, so it never gets created on insert.
2. **A concurrent-upsert race losing counts** (same file) — two upserts racing to create a brand
   new document can hit a duplicate-key error; without a retry, that occurrence's count vanishes.
3. **Missing zstd decompression on the backend** (`packages/backend/src/server.ts`) — the Agent
   compresses (`content-encoding: zstd`), but the backend was passing the compressed bytes straight
   to the NDJSON decoder, which silently found zero valid lines. The POST still returned 202 —
   nothing threw — so this was invisible without an end-to-end check.
4. **The fingerprint algorithm hashing nondeterministic runtime frames**
   (`packages/sdk-node/src/worker/fingerprint.ts`, `stack.ts`) — after any `await`, V8's captured
   stack includes whichever event-loop scheduling path (a promise microtask vs. a timer macrotask)
   happened to resume execution, which varies from call to call and has nothing to do with the
   application's actual code path. Two occurrences of the identical bug in the identical async
   function could fragment into two different issues. Fixed by fingerprinting only in-app frames
   (filtering out `node:internal/...`, `node_modules`, and event-loop resumption frames) — the
   same technique every production error tracker uses, and not something a synchronous unit test
   would ever surface.

None of these were caught by any package's own test suite in isolation — each component did
exactly what its own tests said it should. This is the value of one deliberate cross-component
integration test over trusting composition to work because the parts were each tested.

## Running the demo app manually

See [`docs/runbook.md`](../../docs/runbook.md).

## Running the E2E test

```bash
pnpm test
```

First run downloads `mongodb-memory-server`'s own `mongod` binary into this package's cache
(the test's `beforeAll` is given a 120s timeout to accommodate that); subsequent runs are fast.
