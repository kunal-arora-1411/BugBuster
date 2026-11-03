# Set up BugBuster in your project with an AI coding agent

This page gives you one prompt to paste into an AI coding agent (Claude Code, Cursor, Codex, GitHub
Copilot, …) **inside the repository of the Node.js service you want to monitor**. The agent adds the
BugBuster SDK so that your errors and application logs show up in the BugBuster dashboard, and your
developers can read them without access to the production server.

Already using BugBuster on 0.1 or 0.2? Use [`upgrade-to-0.3.md`](upgrade-to-0.3.md) instead.

The prompt is written so the agent works safely in a repository where other work is in progress: it
makes its own branch, keeps its changes small and additive, can stack on an open pull request, and
does nothing in tests or local development until an API key is set.

## Before you start

You need two things from whoever runs your BugBuster backend (or from your own, if you self-host it;
see [Self-hosting the backend](../README.md#self-hosting-the-backend)):

1. **The backend's ingest URL**, for example `https://bugbuster.yourcompany.in/ingest`.
2. **An API key for your organization**, made on the backend's admin page (`/admin`). Ideally it's
   a key named after this service, so it can be revoked on its own (see
   [Managing organizations](../README.md#managing-organizations-the-admin-page)). It is shown once;
   keep it in your secret manager.

**Neither value goes into the prompt or the repository.** The agent only adds placeholders to
`.env.example`; you set the real values on your servers afterwards.

## How to use it

1. Open the service's repository in your agent.
2. Copy the prompt below. If you want the work stacked on an open pull request, or know of open pull
   requests it must not collide with, fill in the short **About this project** part at the top; the
   rest needs no editing.
3. Let the agent work, then review the pull request it opens.
4. Follow [After the agent is done](#after-the-agent-is-done).

## The prompt

````markdown
Integrate BugBuster into this service: the self-hosted error tracking and application-log platform
whose Node SDK is `@bugbusterhq/sdk-node`. The goal is that developers can read this service's
errors and logs in the BugBuster dashboard without access to the server it runs on.

## About this project (filled in by the person asking; may be left blank)
- Branch or open PR to stack this work on: <none: use the default branch>
- Open PRs this work must not collide with: <none known: check with `gh pr list`>
- Anything else to know (how it's deployed, the Node version in production, the logger in use):
  <nothing>

## 1. Survey first, then plan
Before changing anything, find out and write down in your plan:
- the framework (Express, Fastify, NestJS, Koa, plain `http`, a worker or queue consumer, serverless
  handlers) and every entry point (API server, workers, cron jobs, scripts that run in production);
- CommonJS or ES modules, and the **Node version used in production** (Dockerfile, `.nvmrc`,
  `engines`, the CI and deploy workflows);
- the package manager **production installs with**, and its lockfile (if several lockfiles exist,
  use the one the deploy uses);
- the logger (pino, winston, a custom wrapper, or `console`), and anything that wraps or redacts
  console output;
- how requests already get an id (an `X-Request-Id` / correlation-id middleware, `req.id`, …);
- existing error handling: the framework's error handler, `process.on("unhandledRejection")` /
  `"uncaughtException"`, how workers report failed jobs;
- how the process is stopped (PM2, systemd, containers, a serverless runtime) and any existing
  graceful-shutdown code;
- the test runner and how tests are run in CI;
- the open pull requests (`gh pr list`) and which files each one changes.

## 2. Branching: never disturb other work
- Create a new branch `bugbuster-integration`. Base it on the branch or PR named above if there is
  one, otherwise on the default branch. When stacked, open the PR **against that branch**, not the
  default branch, and say in its description that it must be merged after that PR and then
  retargeted.
- **Never push to, rebase, or force-push** anyone else's branch or the default branch, and never edit
  someone else's PR. If the base branch has its own conflicts with the default branch, leave them to
  that PR; do not resolve them here.
- Keep the diff small and additive: put the integration in **new files** (one module such as
  `src/bugbuster.js` or `lib/bugbuster.ts`, its tests, `docs/BUGBUSTER.md`). In existing files, add
  only a few clearly commented lines. Before editing a file that an open PR also changes, look at that
  PR's diff for the file (`git diff <default>...origin/<their-branch> -- <file>`) and put your lines
  away from its hunks.
- Before opening the PR, prove it does not collide: on a throwaway local branch, `git merge
  --no-commit --no-ff origin/<branch>` for each open PR that touches the same files, note whether it
  merges cleanly, then abort and delete the throwaway branch. Report any conflict in the PR instead of
  resolving it on someone else's branch.

## 3. The SDK: facts to rely on
Read the package README on npm (`@bugbusterhq/sdk-node`) before writing code. Use version `^0.3.0` or
newer (0.1.0 cannot send logs).
- **ESM only.** `require()` of it works on Node ≥ 20.19 and ≥ 22.12. On a CommonJS project whose
  production Node may be older, load it with `await import("@bugbusterhq/sdk-node")` inside your
  module. Either way, **only your one BugBuster module imports the SDK**; the rest of the app imports
  that module.
- **Setup:** `const client = init({ project, apiKey, environment, release, backendUrl, minLogLevel })`,
  called once per process. `project` is the service's name (it is also the `service` shown on its log
  lines); `release` is the git SHA or version if one is available; `minLogLevel` defaults to `"info"`.
  Other options (buffer sizes, flush interval) can keep their defaults.
- **Errors:** `client.captureException(err)`, `client.captureMessage("…")`.
- **Logs:** `client.log.debug|info|warn|error(message, fields)`. `fields` is a plain object of
  structured context; keys named like password, token, secret, apiKey, authorization or cookie are
  redacted by the SDK, and so are emails and bearer tokens inside strings.
- **Existing logger:** `createLogStream(client)` is a writable stream. For pino, `pino(...,
  createLogStream(client))` or add it as a destination; for winston,
  `new winston.transports.Stream({ stream: createLogStream(client) })`. Prefer this over changing
  logging calls.
- **Express (or any Connect-style framework):** `const bb = createExpressIntegration(client, {
  logRequests: { ignorePaths: ["/health"] } })`, then `app.use(bb.requestHandler)` as early as
  possible (it gives every request a trace id so its errors and logs are linked, and reports a 5xx
  that nothing else reported). If the app already assigns a request id, set `req.requestId` to it
  before `bb.requestHandler` runs, so the BugBuster trace id equals the id users and support already
  see. `bb.instrumentConsole()` captures `console.error(err)` as an error;
  `bb.instrumentConsole({ logs: true })` also ships `console.log/info/warn/debug` as log lines.
- **Calls to other services of this application:** if the service calls sibling services over
  HTTP, pass the trace on so one request's logs span every service: `bb.instrumentFetch({
  propagateTo: [<the internal base URLs>] })` once at startup for `fetch`, or
  `headers: bb.traceHeaders()` (an axios interceptor, for example) for other clients. Only list
  the application's own services, never outside APIs. `bb.requestHandler` already continues an
  incoming `traceparent`.
- **Other frameworks:** wrap each request or job in `runWithContext({ traceId, spanId }, () => …)`
  (exported by the SDK) so its log lines and errors share one trace id; for an HTTP request, start
  from `traceFromHeaders(req.headers)` so a caller's trace continues. Call `captureException` from
  the framework's error hook.
- **Delivery:** with `backendUrl` set and no BugBuster Agent on the host, each process sends its own
  batches over HTTPS ("direct mode"). That is what this integration uses. Installing the host Agent
  is an operations step outside this PR.
- **Shutdown:** `await client.shutdown()` sends what is buffered, bounded to about two seconds.

## 4. How to build it
- **One module** owns BugBuster: it reads the configuration, calls `init` once, and exports a small
  facade (`captureException`, `log`, `shutdown`, and the request middleware if any).
- **A safe no-op** when `BUGBUSTER_API_KEY` is unset, and under the test runner (for example
  `process.env.JEST_WORKER_ID` or `NODE_ENV === "test"`): the SDK is not even loaded. Local
  development, CI and the existing test suite must behave exactly as before. Telemetry must never
  throw into the application or slow a request down.
- **Configuration** only from environment variables, all added to `.env.example` (or the project's
  equivalent) with placeholder values, **never real ones**:
  - `BUGBUSTER_API_KEY` (required to turn it on)
  - `BUGBUSTER_BACKEND_URL` (the ingest URL, ending in `/ingest`)
  - `BUGBUSTER_ENVIRONMENT` (optional; default `NODE_ENV`)
  - `BUGBUSTER_RELEASE` (optional; the git SHA or version)
- Add the dependency with the package manager production uses, and commit its updated lockfile.

## 5. What to send
1. **Errors:** report from the framework's global error handler, from places where errors are caught
   and swallowed today, and from background job failures. Add one line in each; do not change what
   those handlers do. If the project already has `unhandledRejection` / `uncaughtException` handlers,
   report from them; do not add new ones that change how the process exits.
2. **Logs:** connect the existing logger through `createLogStream`. If the app logs with `console`,
   use `instrumentConsole({ logs: true })`. If the project wraps or redacts console output, BugBuster's
   console hook must be installed **before** that wrapper, so the wrapper runs first and BugBuster
   receives the redacted text; if load order cannot guarantee that, skip console capture and say why
   in the PR. Never ship output that the project deliberately redacts.
3. **Request context:** mount the request handler (or `runWithContext`) so every log line written
   while handling a request carries that request's trace id: the caller's trace when another service
   sent one (`traceparent`), otherwise the existing request id when there is one.
4. **Calls to the application's own services:** pass the trace on (see "Calls to other services"
   above), so one request can be followed into every service it calls. Never to outside APIs.
5. **Every production process:** API servers, workers and scheduled jobs each initialise BugBuster
   with their own `project` name (for example `orders-api` and `orders-worker`).
6. **Flush on shutdown** from the existing graceful-shutdown path. Do not add a signal handler that
   would stop the process from exiting the way it does today. On serverless, flush before the
   handler returns.

**Privacy:** do not add any new logging of request bodies, passwords, tokens, one-time codes or raw
personal data. Keep any existing hashing or redaction of emails and ids as it is.

## 6. Done means
- The test suite passes with the same results as on the base branch (run it before and after; list
  any failures that already existed on the base).
- New unit tests: the module is a no-op without a key; plus a test for any adapter or parser you
  wrote.
- `docs/BUGBUSTER.md` for the team: what is sent and what is not, how to open the dashboard (the URL
  and API key come from the team lead, never from the repository), filtering by level, service and
  environment, and finding one request by its trace or request id.
- The PR description lists: the environment variables operations must set, every existing file
  touched and why, the result of each test merge against open PRs, and anything you chose to skip.

Out of scope for this PR: deploying, setting environment variables on servers, installing the
BugBuster Agent, and any change unrelated to the integration.
````

## After the agent is done

1. **Review and merge the pull request.** If it was stacked, merge the base pull request first; the
   integration's pull request then targets the default branch.
2. **Set the environment variables** on each server or in your platform's secret settings:
   `BUGBUSTER_API_KEY` and `BUGBUSTER_BACKEND_URL`, plus `BUGBUSTER_ENVIRONMENT` and
   `BUGBUSTER_RELEASE` if you use them. Redeploy so the processes pick them up.
3. **Check it works.** Open the dashboard with the backend URL (without `/ingest`) and the API key:
   the **Logs** tab should show new lines within a few seconds of traffic, and **Issues** fills as
   soon as the service reports an error.
4. **Give your developers access** by sharing the dashboard URL and the API key with the team. The
   key can also send data, so share it only with people who should have it.

## Good to know

- **Optional: the host Agent.** On a long-running server you can later install the BugBuster Agent,
  which merges batches from every service on the host, compresses them and keeps them on disk while
  the backend is unreachable. See [Deploying](../README.md#deploying-the-agent-and-where-your-app-runs).
  The SDK switches to it automatically when it finds the Agent's socket at startup.
- **Logs are kept for 7 days** by default; the backend's `BUGBUSTER_LOG_RETENTION_DAYS` changes that.
- **Questions about the API** are answered by the backend itself: open `/docs` on your backend for
  the interactive reference.
