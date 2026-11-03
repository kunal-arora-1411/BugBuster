import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { getCurrentContext, runWithContext } from "../../src/context.js";
import { createExpressIntegration } from "../../src/integrations/express.js";
import { instrumentFetch, traceFromHeaders, traceHeaders } from "../../src/trace-propagation.js";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN = "00f067aa0ba902b7";

describe("traceFromHeaders", () => {
  it("takes the trace and the caller's span from a valid traceparent", () => {
    expect(traceFromHeaders({ traceparent: `00-${TRACE}-${SPAN}-01` })).toEqual({
      traceId: TRACE,
      parentSpanId: SPAN,
    });
    expect(traceFromHeaders({ traceparent: `00-${TRACE.toUpperCase()}-${SPAN}-00` })?.traceId).toBe(
      TRACE,
    );
  });

  it("ignores an invalid traceparent (bad shape, version ff, all-zero ids)", () => {
    for (const traceparent of [
      "garbage",
      `00-${TRACE}-${SPAN}`,
      `ff-${TRACE}-${SPAN}-01`,
      `00-${"0".repeat(32)}-${SPAN}-01`,
      `00-${TRACE}-${"0".repeat(16)}-01`,
    ]) {
      expect(traceFromHeaders({ traceparent })).toBeUndefined();
    }
  });

  it("falls back to an id-shaped X-Request-Id, and to nothing", () => {
    expect(traceFromHeaders({ "x-request-id": "req-42" })).toEqual({ traceId: "req-42" });
    expect(traceFromHeaders({ "x-request-id": "not an id; drop table" })).toBeUndefined();
    expect(traceFromHeaders({ "x-request-id": "x".repeat(129) })).toBeUndefined();
    expect(traceFromHeaders({})).toBeUndefined();
  });
});

describe("traceHeaders", () => {
  it("passes a W3C trace on as traceparent", () => {
    expect(traceHeaders({ traceId: TRACE, spanId: SPAN })).toEqual({
      traceparent: `00-${TRACE}-${SPAN}-01`,
    });
    const fromUuidSpan = traceHeaders({ traceId: TRACE, spanId: "not-16-hex" }).traceparent;
    expect(fromUuidSpan).toMatch(new RegExp(`^00-${TRACE}-[0-9a-f]{16}-01$`));
  });

  it("passes any other trace id on as X-Request-Id, so the receiver gets the same id", () => {
    const uuid = "2f1c8f8e-6f0b-4c2a-9a59-0f6b2a7c1d3e";
    expect(traceHeaders({ traceId: uuid, spanId: "s" })).toEqual({ "x-request-id": uuid });
  });

  it("is empty outside a request", () => {
    expect(traceHeaders()).toEqual({});
  });
});

function fakeResponse() {
  const res = new EventEmitter() as EventEmitter & { statusCode: number };
  res.statusCode = 200;
  return res;
}

const client = { captureException: () => {}, captureMessage: () => {} };

/** The trace context a request handler gives the route for these request fields. */
function contextFor(req: Record<string, unknown>) {
  const bb = createExpressIntegration(client);
  let seen: ReturnType<typeof getCurrentContext>;
  bb.requestHandler({ method: "GET", url: "/", ...req } as never, fakeResponse() as never, () => {
    seen = getCurrentContext();
  });
  return seen!;
}

describe("requestHandler and incoming trace headers", () => {
  it("continues the caller's trace from traceparent, as a new span under the caller's", () => {
    const ctx = contextFor({ headers: { traceparent: `00-${TRACE}-${SPAN}-01` } });
    expect(ctx.traceId).toBe(TRACE);
    expect(ctx.parentSpanId).toBe(SPAN);
    expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(ctx.spanId).not.toBe(SPAN);
  });

  it("prefers traceparent, then the request id, then X-Request-Id", () => {
    const both = { traceparent: `00-${TRACE}-${SPAN}-01`, "x-request-id": "req-1" };
    expect(contextFor({ headers: both, requestId: "mw-id" }).traceId).toBe(TRACE);
    expect(contextFor({ headers: { "x-request-id": "req-1" }, requestId: "mw-id" }).traceId).toBe(
      "mw-id",
    );
    expect(contextFor({ headers: { "x-request-id": "req-1" } }).traceId).toBe("req-1");
  });

  it("starts a new W3C trace when the request carries none", () => {
    const ctx = contextFor({ headers: {} });
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.parentSpanId).toBeUndefined();
  });

  it("round trip: the service called with traceHeaders() lands in the same trace", () => {
    const bb = createExpressIntegration(client);
    let outgoing: Record<string, string> = {};
    bb.requestHandler(
      { method: "GET", url: "/a", headers: {} } as never,
      fakeResponse() as never,
      () => {
        outgoing = bb.traceHeaders();
      },
    );
    const downstream = contextFor({ headers: outgoing });
    expect(outgoing.traceparent).toContain(downstream.traceId);
    expect(downstream.parentSpanId).toBeDefined();

    // An upstream on a non-W3C id (a request-id middleware) still hands over the same id.
    let viaRequestId: Record<string, string> = {};
    bb.requestHandler(
      { method: "GET", url: "/b", headers: {}, requestId: "order-7" } as never,
      fakeResponse() as never,
      () => {
        viaRequestId = bb.traceHeaders();
      },
    );
    expect(contextFor({ headers: viaRequestId }).traceId).toBe("order-7");
  });
});

describe("instrumentFetch", () => {
  const realFetch = globalThis.fetch;
  let sent: { url: string; headers: Headers }[];
  let restore: () => void = () => {};

  beforeEach(() => {
    sent = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      sent.push({ url, headers });
      return new Response("ok");
    }) as typeof fetch;
  });

  afterEach(() => {
    restore();
    globalThis.fetch = realFetch;
  });

  const inRequest = <T>(fn: () => T) => runWithContext({ traceId: TRACE, spanId: SPAN }, fn);

  it("adds traceparent to a fetch made while handling a request", async () => {
    restore = instrumentFetch();
    await inRequest(() => fetch("http://auth.internal/verify"));
    expect(sent[0]?.headers.get("traceparent")).toBe(`00-${TRACE}-${SPAN}-01`);
  });

  it("leaves a fetch outside a request, and a header the caller set, alone", async () => {
    restore = instrumentFetch();
    await fetch("http://auth.internal/verify");
    expect(sent[0]?.headers.has("traceparent")).toBe(false);
    await inRequest(() =>
      fetch("http://auth.internal/verify", { headers: { traceparent: "caller-set" } }),
    );
    expect(sent[1]?.headers.get("traceparent")).toBe("caller-set");
  });

  it("keeps a Request's own headers", async () => {
    restore = instrumentFetch();
    await inRequest(() =>
      fetch(new Request("http://auth.internal/verify", { headers: { "x-api": "1" } })),
    );
    expect(sent[0]?.headers.get("x-api")).toBe("1");
    expect(sent[0]?.headers.get("traceparent")).toBe(`00-${TRACE}-${SPAN}-01`);
  });

  it("propagateTo limits which URLs get the headers", async () => {
    restore = instrumentFetch({ propagateTo: ["http://auth.internal", /\.svc\.cluster\.local\//] });
    await inRequest(async () => {
      await fetch("http://auth.internal/verify");
      await fetch("http://billing.default.svc.cluster.local/charge");
      await fetch("https://api.stripe.com/v1/charges");
    });
    expect(sent.map((s) => s.headers.has("traceparent"))).toEqual([true, true, false]);
  });

  it("restores the original fetch, and instrumenting twice wraps once", async () => {
    const stub = globalThis.fetch;
    const first = instrumentFetch();
    const second = instrumentFetch();
    await inRequest(() => fetch("http://a/"));
    expect(sent).toHaveLength(1);
    second();
    first();
    expect(globalThis.fetch).toBe(stub);
  });
});
