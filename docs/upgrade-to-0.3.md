# Upgrade a service to BugBuster 0.3 with an AI coding agent

This page is for services that **already use BugBuster** (SDK 0.1 or 0.2). It gives you one prompt
to paste into an AI coding agent (Claude Code, Cursor, Codex, GitHub Copilot, …) inside that
service's repository. The agent upgrades `@bugbusterhq/sdk-node` to 0.3 and connects the service to
the others it calls, so one request can be followed across all of them.

Setting BugBuster up for the first time? Use [`ai-agent-integration.md`](ai-agent-integration.md)
instead; it installs 0.3 directly.

## What 0.3 gives you

- **Issues per service.** The same error in two services is now two issues, one per service. The
  dashboard's Issues view gets a **Service** column and filter.
- **One request across services.** When service A calls service B while handling a request, B joins
  A's trace. An issue's *What this request logged* then shows the lines from every service the
  request passed through, in order, each labeled with its service.
- **Nothing else changes.** No new environment variables, no new keys, and the same `init()` options.

**One-time effect:** after a service upgrades, its errors start new issues (with the same titles),
and its old issues stop growing. That's expected; old issues age out of view on their own.

## Before you start

1. **Update the backend and the dashboard first.** The service column and filter need a backend and
   dashboard from the same release. Following requests across services works with any backend, but
   needs 0.3 on both sides of a call: the service that calls and the service that receives.
2. **Know which services call which.** If you have a list of your internal service URLs, or the
   environment variables that hold them, put it in the prompt. The agent finds them otherwise.

## How to use it

1. Open the service's repository in your agent.
2. Copy the prompt below. Fill in the short **About this project** part at the top if you can; the
   rest needs no editing.
3. Let the agent work, then review the pull request it opens.
4. Repeat for each service. The order doesn't matter, but a call between two services joins up only
   once both are upgraded.
5. Follow [After the agent is done](#after-the-agent-is-done).

## The prompt

````markdown
Upgrade this service's BugBuster SDK (`@bugbusterhq/sdk-node`) to 0.3 and make its calls to the
application's other services carry the request's trace, so the BugBuster dashboard can follow one
request across services.

## About this project (fill in what you know, delete what you don't)
- Base branch or open pull request to stack on: <main, or the PR's branch>
- Open pull requests this must not collide with: <names, or "none">
- The application's other services, and how this service reaches them: <for example
  "auth-service at AUTH_SERVICE_URL, billing at BILLING_URL", or "find them">

## 1. How to work
- Make a new branch from the base above, and open one pull request. Keep the change small and
  additive. Do not reformat, rename or move code you are not changing, and do not touch files that
  the open pull requests above are changing unless you must; if you must, say so in the PR.
- Run the test suite before you change anything and again at the end. Report any failures that
  were already there on the base branch.
- Never add an API key, a backend URL or any other secret to the repository.
- If something below does not fit this project, do the parts that do, and explain the rest in the
  PR instead of guessing.

## 2. Find out how BugBuster is used today
Before changing anything, find and note:
- the current `@bugbusterhq/sdk-node` version (and `@bugbusterhq/types` or `@bugbusterhq/agent`, if
  the project depends on them directly) and which package manager the lockfile belongs to;
- where `init()` is called, and the `project` name each process passes to it;
- where `createExpressIntegration` and `bb.requestHandler` are used, or, on another framework,
  where requests are wrapped in `runWithContext`;
- every place this service makes HTTP calls: `fetch`, axios (and any axios instances it creates),
  got, `node:http`/`https`, or a generated or hand-written client for another service. For each,
  note whether it calls **one of this application's own services** or an **outside API** (payment
  providers, email, third-party SaaS, cloud APIs);
- whether the project already uses OpenTelemetry HTTP instrumentation, or already passes a
  correlation or request id to the services it calls.

## 3. Upgrade the packages
- Set `@bugbusterhq/sdk-node` to `^0.3.0` (and any other `@bugbusterhq/*` package the project
  depends on directly, to the same version). Install with the project's own package manager so only
  the lockfile entries for these packages change.
- Nothing in `init()` needs to change. The SDK stays ESM-only, and stays a no-op without an API key.
- If the code calls `computeFingerprint` itself (rare), it now takes an optional `service`; leave
  existing calls as they are.

## 4. Check the `project` names
0.3 groups errors per `project`, so these names now decide which issues are kept apart:
- Each service, and each kind of process within it (API server, worker, scheduled job), should have
  its own fixed name, for example `orders-api` and `orders-worker`.
- A name must not change between instances or deploys. If it includes a hostname, pod name, process
  id, version or anything else that varies, every instance would get its own copy of every issue:
  move that part into `release` or a log field and keep `project` fixed.
- Do not rename a service that already has a fixed name; renaming starts all its issues afresh.

## 5. Receive the caller's trace
- **Express or another Connect-style framework:** nothing to do. `bb.requestHandler` in 0.3
  continues the caller's trace when a request carries a W3C `traceparent` header, then the request id
  a middleware set on `req.requestId`, then an `X-Request-Id` header. Leave it where it is.
- **Another framework** (Fastify, Koa, a NestJS adapter, a raw `http` server) that wraps requests
  in `runWithContext` itself: start from the incoming headers so the caller's trace wins, keeping
  the project's own request id as the next choice:

  ```ts
  import { newSpanId, newTraceId, runWithContext, traceFromHeaders } from "@bugbusterhq/sdk-node";

  const incoming = traceFromHeaders(req.headers);
  const fromCaller = incoming?.parentSpanId !== undefined ? incoming : undefined;
  runWithContext(
    {
      traceId: fromCaller?.traceId ?? existingRequestId ?? incoming?.traceId ?? newTraceId(),
      spanId: newSpanId(),
      ...(fromCaller ? { parentSpanId: fromCaller.parentSpanId } : {}),
    },
    () => handle(req, res),
  );
  ```

## 6. Pass the trace on to the application's own services
Only calls to **this application's own services** get the trace. Never add it to calls to outside
APIs.
- **`fetch`:** once per process at startup, right after the Express integration is created, add
  `bb.instrumentFetch({ propagateTo })`. Build `propagateTo` from the same configuration the code
  already uses for those services' URLs (skip any that are unset), so it follows each environment:

  ```ts
  bb.instrumentFetch({
    propagateTo: [process.env.AUTH_SERVICE_URL, process.env.BILLING_URL].filter(
      (url): url is string => !!url,
    ),
  });
  ```

  A string matches any URL that starts with it; a RegExp is tested against the whole URL (for
  example `/\.svc\.cluster\.local\//` for every service in a Kubernetes cluster). Without
  `propagateTo` every `fetch` gets the trace, so always pass it. If the process has no Express
  integration, use the package's own export: `import { instrumentFetch } from "@bugbusterhq/sdk-node"`.
- **axios, got, `node:http` or a service client:** add the headers from `traceHeaders()` (the
  package export, or `bb.traceHeaders()`) where requests to these services are built, without
  replacing a header that is already set. For an axios instance used only for internal services:

  ```ts
  import { traceHeaders } from "@bugbusterhq/sdk-node";

  internalApi.interceptors.request.use((config) => {
    for (const [name, value] of Object.entries(traceHeaders())) {
      if (config.headers.get(name) == null) config.headers.set(name, value);
    }
    return config;
  });
  ```

  On axios older than 1.0, `config.headers` is a plain object: check and set `config.headers[name]`
  instead. If one axios instance serves both internal and outside URLs, check the request URL
  against the same list as `propagateTo` before adding the headers.
- `traceHeaders()` is empty outside a request (startup code, timers), so those calls are unchanged.
- **Already passes a correlation or request id** to the services it calls? Keep it. Add BugBuster's
  headers alongside it; they never replace a header that is already set.
- **Already uses OpenTelemetry HTTP instrumentation?** Do not add BugBuster's propagation on top of
  it: both would write `traceparent`. Leave this step out and say so in the PR; the team decides.
- **Message queues and background jobs** are out of scope for this change. If the service already
  passes a request id through job payloads, leave that alone.

## 7. Tests
- Add a test that a call to one of the application's own services, made inside
  `runWithContext({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7" }, …)`,
  carries a `traceparent` header containing that trace id, and that a call to an outside API made
  the same way does not. Mock the HTTP layer the way the project's tests already do; make no real
  network calls.
- The whole suite must pass with the same results as before the change.

## 8. Documentation
If the repository has a `docs/BUGBUSTER.md` (or similar notes on BugBuster), update it:
- errors are grouped per service, and the dashboard can filter issues and logs by service;
- *What this request logged* on an issue, and the Logs view's trace filter, follow a request into
  the other upgraded services it called;
- which services this one passes the trace to, and where that list is configured.

## 9. The pull request
The description lists:
- the version change, and that after deploying, this service's errors start new issues once (with
  the same titles) while its old issues stop growing;
- the `project` name(s) this service uses, and any you changed and why;
- which services now receive the trace, how `propagateTo` (or the interceptor's check) is built,
  and which outside APIs were deliberately left out;
- anything from this prompt you skipped and why (for example OpenTelemetry already present);
- that no new environment variables or secrets are needed.
````

## After the agent is done

1. **Review the PR**: especially that only your own services receive the trace, and that no
   `project` name varies per instance.
2. **Deploy.** No configuration changes are needed.
3. **Check it in the dashboard:**
   - In **Issues**, the Service column and filter appear once two or more services report errors.
   - Make a request that goes through two upgraded services and fails in the second, then open
     that issue. *What this request logged* should say "across 2 services" and show both services'
     lines in order. Or copy a trace id from a log line, open **Logs**, and choose *Show everything
     in this request*.
   - If the second service's lines are missing, the call to it didn't carry the trace: check that
     its URL is in `propagateTo` (or the interceptor's list), and that both services run 0.3.
