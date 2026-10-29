import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LogLevel } from "@bugbusterhq/types";
import type { CaptureEngine } from "../capture.js";
import { runWithContext } from "../context.js";
import { createLogApi, type LogApi, type LogFields } from "../logger.js";

/**
 * Auto-instrumentation for Express (and any framework with the same request/response/next
 * shape — Connect, plain `http` middleware chains). This is the difference between "install a
 * library and call two functions" and hand-rolling console interception, trace context, and a
 * 500-without-a-captured-exception safety net per integration — see docs/architecture's
 * production-integration retrospective for why this exists as a first-class SDK feature rather
 * than something every host application rebuilds.
 */

interface RequestState {
  captured: boolean;
}

// Deliberately separate from context.ts's trace-context AsyncLocalStorage: this one tracks
// per-request integration bookkeeping ("did anything already report this request's failure"),
// not wire-format trace/span data, so it has no business living in the public BugBusterContext.
const requestState = new AsyncLocalStorage<RequestState>();

/** Marks the current request (if any) as having had something captured. */
function markCaptured(): void {
  const state = requestState.getStore();
  if (state) state.captured = true;
}

/**
 * The slice of a client this integration needs. `captureLog` is optional so any object with just
 * the original two methods (an older client, a test double) still works — log features simply
 * become no-ops for it.
 */
export type IntegrationClient = Pick<CaptureEngine, "captureException" | "captureMessage"> &
  Partial<Pick<CaptureEngine, "captureLog" | "isLogLevelEnabled">>;

/** Wraps a client so every manual capture call also marks the current request captured. */
function trackingClient(client: IntegrationClient): CaptureEngine {
  return {
    captureException(error, extra) {
      markCaptured();
      client.captureException(error, extra);
    },
    captureMessage(message, extra) {
      markCaptured();
      client.captureMessage(message, extra);
    },
    // Deliberately does NOT markCaptured(): an `info` line is not a report of failure, and must
    // never suppress the HandledHttpError safety net for a 5xx nothing else reported.
    captureLog(level, message, fields) {
      client.captureLog?.(level, message, fields);
    },
    isLogLevelEnabled(level) {
      if (!client.captureLog) return false;
      // A client without the check (an older client, a test double) filters inside captureLog.
      return client.isLogLevelEnabled?.(level) ?? true;
    },
  };
}

export interface ExpressRequestLike extends IncomingMessage {
  /** Set by an upstream request-id middleware, if any; falls back to a fresh id otherwise. */
  requestId?: string;
  /** Present once Express has matched a route; used for a low-cardinality error name. */
  route?: { path?: unknown };
  method?: string;
  /** Express sets these; `originalUrl` survives router mounting, `url` does not. */
  originalUrl?: string;
  baseUrl?: string;
}

export interface ExpressIntegrationOptions {
  /**
   * Emit one structured log line per finished request — `GET /orders/42 200 12ms` — carrying
   * method, path, matched route, status, duration, and the request's trace id, so a developer can
   * jump from an error to everything else that request did. 2xx/3xx log at `info`, 4xx at `warn`,
   * 5xx at `error`. Query strings are never logged (they routinely carry tokens and PII).
   *
   * Off by default: shipping every request is a decision about volume the host app should make.
   * Pass `{ ignorePaths: ["/healthz"] }` to skip noisy probe endpoints.
   */
  logRequests?: boolean | { ignorePaths?: readonly string[] };
}

export interface InstrumentConsoleOptions {
  /**
   * Also record every `console.debug/log/info/warn/error` call as a log line (levels debug, info,
   * info, warn, error). Off by default — it ships whatever the app prints, so it is an explicit
   * opt-in. Independent of (and in addition to) the exception capture below.
   */
  logs?: boolean;
}

export interface BugBusterExpressIntegration extends CaptureEngine {
  /**
   * `app.use(bb.requestHandler)` — mount early, before routes. Propagates trace context for the
   * lifetime of the request and, on `res.finish`, synthesizes a `HandledHttpError` for any 5xx
   * response that nothing else already reported (Appendix A's "never silently lose a failure"
   * invariant) without double-counting requests that called `bb.captureException` themselves.
   * With `logRequests` enabled it also writes the per-request access log line.
   */
  requestHandler: (
    req: ExpressRequestLike,
    res: ServerResponse,
    next: (err?: unknown) => void,
  ) => void;
  /**
   * Overrides console.error/console.warn for the lifetime of the process (or until the returned
   * function is called): console.error captures `Error` arguments, console.warn captures both
   * `Error` arguments and bare string arguments (as a low-fidelity `captureMessage`) — bare
   * strings passed to console.error are deliberately left alone, to avoid conflating a log label
   * with a real error. With `{ logs: true }`, additionally records console.debug/log/info/warn/
   * error output as log lines. Returns a restore function.
   */
  instrumentConsole: (options?: InstrumentConsoleOptions) => () => void;
  /** `bb.log.info("order placed", { orderId })` — same API as `client.log`, trace-aware. */
  log: LogApi;
}

const CONSOLE_LOG_LEVELS = {
  debug: "debug",
  log: "info",
  info: "info",
  warn: "warn",
  error: "error",
} as const satisfies Record<string, LogLevel>;

function statusToLevel(status: number): LogLevel {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return "info";
}

export function createExpressIntegration(
  client: IntegrationClient,
  options: ExpressIntegrationOptions = {},
): BugBusterExpressIntegration {
  const tracked = trackingClient(client);

  const requestLogOption = options.logRequests;
  const logRequests = requestLogOption === true || typeof requestLogOption === "object";
  const ignorePaths = new Set(
    typeof requestLogOption === "object" ? (requestLogOption.ignorePaths ?? []) : [],
  );

  function logFinishedRequest(
    req: ExpressRequestLike,
    res: ServerResponse,
    startedAt: bigint,
  ): void {
    const rawUrl = req.originalUrl ?? req.url ?? "";
    const path = rawUrl.split("?")[0] || "/";
    if (ignorePaths.has(path)) return;

    const status = res.statusCode;
    const method = req.method ?? "?";
    const durationMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e5) / 10;
    const routePath = typeof req.route?.path === "string" ? req.route.path : undefined;

    const fields: LogFields = { method, path, status, durationMs };
    if (routePath !== undefined) fields.route = `${req.baseUrl ?? ""}${routePath}`;
    if (req.requestId !== undefined) fields.requestId = req.requestId;

    tracked.captureLog(
      statusToLevel(status),
      `${method} ${path} ${status} ${durationMs}ms`,
      fields,
    );
  }

  function requestHandler(
    req: ExpressRequestLike,
    res: ServerResponse,
    next: (err?: unknown) => void,
  ): void {
    const state: RequestState = { captured: false };
    const context = { traceId: req.requestId ?? randomUUID(), spanId: randomUUID() };
    const startedAt = process.hrtime.bigint();

    res.once("finish", () => {
      // `finish` listeners run in the emitter's async context, not where they were registered —
      // so the trace context is re-established explicitly for everything emitted from here.
      runWithContext(context, () => {
        if (res.statusCode >= 500 && !state.captured) {
          const route = typeof req.route?.path === "string" ? req.route.path : "<unmatched>";
          const error = new Error(`HTTP ${res.statusCode}: ${req.method ?? "?"} ${route}`);
          // Grouped by error type + stack (fingerprint.ts) — the route/method distinguishes
          // otherwise-identical HandledHttpErrors from colliding into one issue.
          error.name = `HandledHttpError:${req.method ?? "?"}:${route}`;
          tracked.captureException(error);
        }
        if (logRequests) logFinishedRequest(req, res, startedAt);
      });
    });

    requestState.run(state, () => runWithContext(context, next));
  }

  function instrumentConsole(consoleOptions: InstrumentConsoleOptions = {}): () => void {
    const logs = consoleOptions.logs === true;
    const originalError = console.error;
    const originalWarn = console.warn;
    const originalDebug = console.debug;
    const originalLog = console.log;
    const originalInfo = console.info;

    const emitLog = (level: LogLevel, args: unknown[]): void => {
      // Level check BEFORE format(): with minLogLevel "warn", a console.log(bigObject) in a hot
      // loop must not pay for a deep inspect whose result would be thrown away.
      if (!logs || !tracked.isLogLevelEnabled(level)) return;
      try {
        tracked.captureLog(level, format(...args));
      } catch {
        // formatting a hostile object must never break the host's own console call
      }
    };

    console.error = (...args: unknown[]) => {
      for (const arg of args) {
        if (arg instanceof Error) tracked.captureException(arg);
      }
      emitLog("error", args);
      originalError.apply(console, args);
    };
    console.warn = (...args: unknown[]) => {
      for (const arg of args) {
        if (arg instanceof Error) tracked.captureException(arg);
        else if (typeof arg === "string") tracked.captureMessage(arg);
      }
      emitLog("warn", args);
      originalWarn.apply(console, args);
    };

    // debug/log/info are only touched when log capture was asked for: with the default options
    // this function overrides exactly what it always did, nothing more.
    if (logs) {
      console.debug = (...args: unknown[]) => {
        emitLog(CONSOLE_LOG_LEVELS.debug, args);
        originalDebug.apply(console, args);
      };
      console.log = (...args: unknown[]) => {
        emitLog(CONSOLE_LOG_LEVELS.log, args);
        originalLog.apply(console, args);
      };
      console.info = (...args: unknown[]) => {
        emitLog(CONSOLE_LOG_LEVELS.info, args);
        originalInfo.apply(console, args);
      };
    }

    return () => {
      console.error = originalError;
      console.warn = originalWarn;
      console.debug = originalDebug;
      console.log = originalLog;
      console.info = originalInfo;
    };
  }

  return {
    captureException: tracked.captureException,
    captureMessage: tracked.captureMessage,
    captureLog: tracked.captureLog,
    isLogLevelEnabled: tracked.isLogLevelEnabled,
    log: createLogApi(tracked.captureLog),
    requestHandler,
    instrumentConsole,
  };
}
