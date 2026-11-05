import { randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { CAUSE_FINGERPRINT_PATTERN, HEADER_CAUSE } from "@bugbusterhq/types";
import { getCurrentContext, type BugBusterContext } from "./context.js";

/**
 * Following one request across services. A service that receives a request adopts the caller's
 * trace id (from the W3C `traceparent` header, or `X-Request-Id`); a service that makes a call
 * passes its own trace id on in the same headers. Every service then stamps the same trace id on
 * its log lines and errors, so the dashboard's "logs for this request" spans all of them.
 */

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const W3C_TRACE_ID = /^[0-9a-f]{32}$/;
const W3C_SPAN_ID = /^[0-9a-f]{16}$/;
const ALL_ZEROS = /^0+$/;
/** An `X-Request-Id` is adopted only if it looks like an id, not arbitrary text. */
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** A new trace id in W3C form (32 hex), so it can be passed on in `traceparent`. */
export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

/** A new span id in W3C form (16 hex). */
export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value.trim() : undefined;
}

/**
 * The trace a request belongs to, from its headers: the caller's `traceparent` first, then
 * `X-Request-Id`. Undefined when neither is present or valid, and the request starts a new trace.
 */
export function traceFromHeaders(
  headers: IncomingHttpHeaders,
): Pick<BugBusterContext, "traceId" | "parentSpanId"> | undefined {
  const parent = TRACEPARENT.exec(header(headers, "traceparent")?.toLowerCase() ?? "");
  if (parent && parent[1] !== "ff" && !ALL_ZEROS.test(parent[2]!) && !ALL_ZEROS.test(parent[3]!)) {
    return { traceId: parent[2]!, parentSpanId: parent[3]! };
  }
  const requestId = header(headers, "x-request-id");
  if (requestId && REQUEST_ID.test(requestId)) return { traceId: requestId };
  return undefined;
}

/**
 * Headers that carry the current request's trace to another service: `traceparent` when the trace
 * id is in W3C form (every trace the SDK starts is), `X-Request-Id` otherwise, so the receiving
 * service ends up with exactly the same trace id. Empty outside a request.
 *
 *   await fetch(url, { headers: { ...bb.traceHeaders() } });
 */
export function traceHeaders(ctx = getCurrentContext()): Record<string, string> {
  if (!ctx) return {};
  if (!W3C_TRACE_ID.test(ctx.traceId) || ALL_ZEROS.test(ctx.traceId)) {
    return REQUEST_ID.test(ctx.traceId) ? { "x-request-id": ctx.traceId } : {};
  }
  const spanId = W3C_SPAN_ID.test(ctx.spanId) ? ctx.spanId : newSpanId();
  return { traceparent: `00-${ctx.traceId}-${spanId}-01` };
}

export interface InstrumentFetchOptions {
  /**
   * Only calls to these URLs get trace headers: a string matches a URL that starts with it, a
   * RegExp is tested against the whole URL. Default: every call. Set it to keep trace ids from
   * going to outside APIs.
   */
  propagateTo?: readonly (string | RegExp)[];
}

const WRAPPED = Symbol.for("bugbuster.fetch.wrapped");
type WrappedFetch = typeof fetch & { [WRAPPED]?: typeof fetch };

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Makes the global `fetch` pass the current request's trace on to the services it calls. A header
 * the caller set explicitly is never replaced. Returns a function that puts the original back.
 * Calls made outside a request are sent unchanged.
 */
export function instrumentFetch(options: InstrumentFetchOptions = {}): () => void {
  const current = globalThis.fetch as WrappedFetch | undefined;
  if (typeof current !== "function") return () => {};
  const original = current[WRAPPED] ?? current; // instrumenting twice wraps once
  const targets = options.propagateTo;

  const matches = (url: string) =>
    !targets || targets.some((t) => (typeof t === "string" ? url.startsWith(t) : t.test(url)));

  const wrapped: WrappedFetch = function (input, init) {
    const extra = traceHeaders();
    if (Object.keys(extra).length === 0) return original(input, init);
    let url: string;
    try {
      url = urlOf(input);
    } catch {
      return original(input, init);
    }
    if (!matches(url)) return original(input, init);
    // init.headers, when given, replaces a Request's own headers, so start from whichever applies.
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    for (const [name, value] of Object.entries(extra)) {
      if (!headers.has(name)) headers.set(name, value);
    }
    // Read the callee's answer in the caller's request context, captured now: the issue a
    // failed call names becomes the cause of this request's later errors.
    const ctx = getCurrentContext();
    return original(input, { ...init, headers }).then((response) => {
      noteDownstreamResponse(response, ctx);
      return response;
    });
  };
  wrapped[WRAPPED] = original;
  globalThis.fetch = wrapped;

  return () => {
    if (globalThis.fetch === wrapped) globalThis.fetch = original;
  };
}

/** A response's headers, from `fetch` (`Headers`), Node's `http`, axios, got, or a plain object. */
export type ResponseHeadersLike =
  { get(name: string): string | null | undefined } | Record<string, unknown>;

function causeHeaderOf(headers: ResponseHeadersLike | undefined): string | undefined {
  if (!headers) return undefined;
  let value: unknown;
  if (typeof (headers as { get?: unknown }).get === "function") {
    try {
      value = (headers as { get(name: string): unknown }).get(HEADER_CAUSE);
    } catch {
      return undefined;
    }
  } else {
    const wanted = HEADER_CAUSE.toLowerCase();
    for (const [name, v] of Object.entries(headers)) {
      if (name.toLowerCase() === wanted) value = v;
    }
  }
  if (Array.isArray(value)) value = value[0];
  return typeof value === "string" && CAUSE_FINGERPRINT_PATTERN.test(value.trim())
    ? value.trim()
    : undefined;
}

/**
 * Tells BugBuster how a call to another service went, so an error this request raises later is
 * linked to the issue that service failed with (docs/architecture/root-cause-graph.md). `fetch`
 * calls do this by themselves once `instrumentFetch()` is on; for axios, got or `http`:
 *
 *   const res = await axios.get(url, { headers: bb.traceHeaders(), validateStatus: () => true });
 *   bb.noteDownstreamResponse(res);
 *
 * Only a 5xx carrying a well-formed `X-BB-Cause` counts; anything else is ignored, and a call
 * outside a request does nothing. Never throws.
 */
export function noteDownstreamResponse(
  response: { status?: number; statusCode?: number; headers?: ResponseHeadersLike },
  ctx: BugBusterContext | undefined = getCurrentContext(),
): void {
  try {
    if (!ctx || !response) return;
    const status = response.status ?? response.statusCode;
    if (typeof status !== "number" || status < 500) return;
    const cause = causeHeaderOf(response.headers);
    if (cause) ctx.downstreamCause = cause;
  } catch {
    // a hostile headers object must never break the caller's request
  }
}
