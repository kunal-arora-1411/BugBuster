import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CaptureEngine } from "../capture.js";
import { runWithContext } from "../context.js";

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

/** Wraps a CaptureEngine so every manual capture call also marks the current request captured. */
function trackingClient(client: CaptureEngine): CaptureEngine {
  return {
    captureException(error, extra) {
      markCaptured();
      client.captureException(error, extra);
    },
    captureMessage(message, extra) {
      markCaptured();
      client.captureMessage(message, extra);
    },
  };
}

export interface ExpressRequestLike extends IncomingMessage {
  /** Set by an upstream request-id middleware, if any; falls back to a fresh id otherwise. */
  requestId?: string;
  /** Present once Express has matched a route; used for a low-cardinality error name. */
  route?: { path?: unknown };
  method?: string;
}

export interface BugBusterExpressIntegration extends CaptureEngine {
  /**
   * `app.use(bb.requestHandler)` — mount early, before routes. Propagates trace context for the
   * lifetime of the request and, on `res.finish`, synthesizes a `HandledHttpError` for any 5xx
   * response that nothing else already reported (Appendix A's "never silently lose a failure"
   * invariant) without double-counting requests that called `bb.captureException` themselves.
   */
  requestHandler: (req: ExpressRequestLike, res: ServerResponse, next: (err?: unknown) => void) => void;
  /**
   * Overrides console.error/console.warn for the lifetime of the process (or until the returned
   * function is called): console.error captures `Error` arguments, console.warn captures both
   * `Error` arguments and bare string arguments (as a low-fidelity `captureMessage`) — bare
   * strings passed to console.error are deliberately left alone, to avoid conflating a log label
   * with a real error. Returns a restore function.
   */
  instrumentConsole: () => () => void;
}

export function createExpressIntegration(client: CaptureEngine): BugBusterExpressIntegration {
  const tracked = trackingClient(client);

  function requestHandler(
    req: ExpressRequestLike,
    res: ServerResponse,
    next: (err?: unknown) => void,
  ): void {
    const state: RequestState = { captured: false };
    const context = { traceId: req.requestId ?? randomUUID(), spanId: randomUUID() };

    res.once("finish", () => {
      if (res.statusCode >= 500 && !state.captured) {
        runWithContext(context, () => {
          const route = typeof req.route?.path === "string" ? req.route.path : "<unmatched>";
          const error = new Error(`HTTP ${res.statusCode}: ${req.method ?? "?"} ${route}`);
          // Grouped by error type + stack (fingerprint.ts) — the route/method distinguishes
          // otherwise-identical HandledHttpErrors from colliding into one issue.
          error.name = `HandledHttpError:${req.method ?? "?"}:${route}`;
          tracked.captureException(error);
        });
      }
    });

    requestState.run(state, () => runWithContext(context, next));
  }

  function instrumentConsole(): () => void {
    const originalError = console.error;
    const originalWarn = console.warn;

    console.error = (...args: unknown[]) => {
      for (const arg of args) {
        if (arg instanceof Error) tracked.captureException(arg);
      }
      originalError.apply(console, args);
    };
    console.warn = (...args: unknown[]) => {
      for (const arg of args) {
        if (arg instanceof Error) tracked.captureException(arg);
        else if (typeof arg === "string") tracked.captureMessage(arg);
      }
      originalWarn.apply(console, args);
    };

    return () => {
      console.error = originalError;
      console.warn = originalWarn;
    };
  }

  return {
    captureException: tracked.captureException,
    captureMessage: tracked.captureMessage,
    requestHandler,
    instrumentConsole,
  };
}
