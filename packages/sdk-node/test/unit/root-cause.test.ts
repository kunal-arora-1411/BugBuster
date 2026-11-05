import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decodeEnvelopeItems,
  HEADER_CAUSE,
  MAX_CAUSES_PER_DELTA,
  type BugBusterEvent,
  type FoldDelta,
} from "@bugbusterhq/types";
import { init, type BugBusterClient } from "../../src/index.js";
import { runWithContext, type BugBusterContext } from "../../src/context.js";
import { createExpressIntegration } from "../../src/integrations/express.js";
import { instrumentFetch, noteDownstreamResponse } from "../../src/trace-propagation.js";
import { FoldTable } from "../../src/worker/fold.js";
import { fingerprintOfError, processCapture } from "../../src/worker/pipeline.js";
import type { RawCapture } from "../../src/raw-capture.js";
import { RingBuffer } from "../../src/ring-buffer.js";
import { createCaptureEngine } from "../../src/capture.js";
import { createSampler } from "../../src/sampler.js";
import { createDropCounters } from "../../src/drop-counters.js";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN = "00f067aa0ba902b7";
const TRACEPARENT = `00-${TRACE}-${SPAN}-01`;
const FP = "fp_0123456789abcdef";

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    }),
  );
}
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

describe("noteDownstreamResponse", () => {
  const ctx = (): BugBusterContext => ({ traceId: TRACE, spanId: SPAN });

  it("remembers the cause a 5xx names, from Headers or a plain object, any case", () => {
    const a = ctx();
    noteDownstreamResponse({ status: 503, headers: new Headers({ [HEADER_CAUSE]: FP }) }, a);
    expect(a.downstreamCause).toBe(FP);

    const b = ctx();
    noteDownstreamResponse({ statusCode: 500, headers: { "x-bb-cause": [FP] } }, b);
    expect(b.downstreamCause).toBe(FP);
  });

  it("ignores a non-5xx, a malformed value, no header, and a call outside a request", () => {
    for (const response of [
      { status: 404, headers: { "x-bb-cause": FP } },
      { status: 500, headers: { "x-bb-cause": "fp_not-hex" } },
      { status: 500, headers: { "x-bb-cause": "<script>" } },
      { status: 500, headers: {} },
      { status: 500 },
    ]) {
      const c = ctx();
      noteDownstreamResponse(response, c);
      expect(c.downstreamCause).toBeUndefined();
    }
    expect(() =>
      noteDownstreamResponse({ status: 500, headers: { "x-bb-cause": FP } }),
    ).not.toThrow();
  });

  it("never throws on a hostile headers object", () => {
    const hostile = {
      get() {
        throw new Error("nope");
      },
    };
    expect(() => noteDownstreamResponse({ status: 500, headers: hostile }, ctx())).not.toThrow();
  });
});

describe("pipeline and fold: errors carry their cause", () => {
  const service = { name: "orders", version: "1", environment: "test" };
  const raw = (error: Error, causedBy?: string): RawCapture => ({
    kind: "exception",
    error,
    timestampMs: Date.now(),
    context: { traceId: TRACE, spanId: SPAN },
    ...(causedBy ? { causedBy } : {}),
  });

  it("counts, per fingerprint, how many occurrences followed each cause", () => {
    const foldTable = new FoldTable(100);
    const deps = {
      foldTable,
      seenFingerprints: new Set<string>(),
      newFingerprintsThisFlush: new Set<string>(),
      serviceContext: service,
    };
    // One construction site, so all five share a stack and therefore a fingerprint.
    const causes = [FP, FP, FP, "fp_ffffffffffffffff", undefined];
    for (const cause of causes)
      processCapture(raw(new Error("inventory returned 500"), cause), deps);

    const { deltas, exemplars } = foldTable.drain();
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.count).toBe(5);
    expect(deltas[0]!.causedBy).toEqual({ [FP]: 3, fp_ffffffffffffffff: 1 });
    // An example event records the cause of that one occurrence, as evidence for the link.
    expect(exemplars.some((e) => e.causedBy === FP)).toBe(true);
  });

  it("omits causedBy when nothing had a cause, drops a self-link, and caps distinct causes", () => {
    const foldTable = new FoldTable(100);
    const deps = {
      foldTable,
      seenFingerprints: new Set<string>(),
      newFingerprintsThisFlush: new Set<string>(),
      serviceContext: service,
    };
    const err = () => new Error("x");
    processCapture(raw(err()), deps);
    expect(foldTable.drain().deltas[0]!.causedBy).toBeUndefined();

    const self = err();
    processCapture(raw(self, fingerprintOfError(self, "orders", new WeakMap())), deps);
    expect(foldTable.drain().deltas[0]!.causedBy).toBeUndefined();

    for (let i = 0; i < MAX_CAUSES_PER_DELTA + 5; i++) {
      processCapture(raw(err(), `fp_${i.toString(16).padStart(16, "0")}`), deps);
    }
    expect(Object.keys(foldTable.drain().deltas[0]!.causedBy!)).toHaveLength(MAX_CAUSES_PER_DELTA);
  });

  it("fingerprintOfError gives exactly the fingerprint the flush groups the error under", () => {
    const foldTable = new FoldTable(100);
    const cache = new WeakMap<Error, string>();
    const error = new Error("boom");
    const early = fingerprintOfError(error, "orders", cache);

    // Without the cache the pipeline recomputes from scratch, and must land on the same value.
    processCapture(raw(error), {
      foldTable,
      seenFingerprints: new Set(),
      newFingerprintsThisFlush: new Set(),
      serviceContext: service,
    });
    expect(foldTable.drain().deltas[0]!.fingerprint).toBe(early);
  });
});

describe("three services, one database timeout: the cause travels up the chain", () => {
  let collector: Server;
  let collectorUrl: string;
  const envelopes: Buffer[] = [];
  const servers: Server[] = [];
  const clients: BugBusterClient[] = [];
  let restoreFetch: () => void = () => {};

  beforeEach(async () => {
    envelopes.length = 0;
    collector = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        envelopes.push(Buffer.concat(chunks));
        res.writeHead(202).end();
      });
    });
    collectorUrl = await listen(collector);
  });

  afterEach(async () => {
    restoreFetch();
    await Promise.all(servers.splice(0).map(close));
    clients.length = 0;
    await close(collector);
  });

  function service(project: string, options: { causeHeader?: boolean } = {}) {
    const client = init({
      project,
      apiKey: "sk_test",
      backendUrl: `${collectorUrl}/ingest`,
      agentSocketPath: "/nonexistent/bugbuster.sock",
      flushMaxDelayMs: 60_000,
    });
    clients.push(client);
    return { client, bb: createExpressIntegration(client, options) };
  }

  async function serve(
    bb: ReturnType<typeof service>["bb"],
    handler: (res: ServerResponse) => Promise<void> | void,
  ): Promise<string> {
    const server = createServer((req, res) =>
      bb.requestHandler(req, res, () => {
        void Promise.resolve(handler(res)).catch(() => {
          res.statusCode = 500;
          res.end();
        });
      }),
    );
    servers.push(server);
    return listen(server);
  }

  async function folds(): Promise<{ deltas: FoldDelta[]; events: BugBusterEvent[] }> {
    await Promise.all(clients.map((c) => c.shutdown()));
    const items = envelopes.flatMap((e) => decodeEnvelopeItems(e));
    return {
      deltas: items.flatMap((i) => (i.type === "fold" ? [i.payload] : [])),
      events: items.flatMap((i) => (i.type === "exemplar" ? [i.payload] : [])),
    };
  }

  it("inventory names its timeout; orders and checkout link their failures to it", async () => {
    restoreFetch = instrumentFetch();
    const inventory = service("inventory");
    const orders = service("orders");
    const checkout = service("checkout");

    let inventoryFp: string | undefined;

    const inventoryUrl = await serve(inventory.bb, (res) => {
      const err = new Error("connection timed out");
      err.name = "MongoTimeoutError";
      inventory.bb.captureException(err);
      inventoryFp = inventory.client.fingerprintOf(err);
      res.statusCode = 500;
      res.end("db down");
    });
    // orders: calls inventory, and on failure answers 500 without capturing anything itself —
    // the SDK's synthetic HandledHttpError is what gets linked.
    const ordersUrl = await serve(orders.bb, async (res) => {
      const r = await fetch(`${inventoryUrl}/stock`);
      res.statusCode = r.ok ? 200 : 500;
      res.end();
    });
    const checkoutUrl = await serve(checkout.bb, async (res) => {
      const r = await fetch(`${ordersUrl}/orders`);
      if (!r.ok) checkout.bb.captureException(new Error("could not place order"));
      res.statusCode = r.ok ? 200 : 502;
      res.end();
    });

    // A browser hitting checkout sends no traceparent, so it must not see an X-BB-Cause.
    const outer = await fetch(`${checkoutUrl}/checkout`);
    expect(outer.status).toBe(502);
    expect(outer.headers.get(HEADER_CAUSE)).toBeNull();

    // A traced caller does see one: orders names the issue it failed with.
    const traced = await fetch(`${ordersUrl}/orders`, { headers: { traceparent: TRACEPARENT } });
    expect(traced.status).toBe(500);
    expect(traced.headers.get(HEADER_CAUSE)).toMatch(/^fp_[0-9a-f]{16}$/);

    const { deltas, events } = await folds();
    const byService = (name: string) => deltas.filter((d) => d.service === name);

    const [inv] = byService("inventory");
    expect(inv!.fingerprint).toBe(inventoryFp);
    expect(inv!.causedBy).toBeUndefined(); // the root: nothing downstream of it failed

    const [ord] = byService("orders");
    expect(ord!.causedBy).toEqual({ [inventoryFp!]: 2 }); // both requests that reached it
    expect(traced.headers.get(HEADER_CAUSE)).toBe(ord!.fingerprint);

    const [chk] = byService("checkout");
    expect(chk!.causedBy).toEqual({ [ord!.fingerprint]: 1 });
    expect(events.find((e) => e.fingerprint === chk!.fingerprint)?.causedBy).toBe(ord!.fingerprint);
  });

  it("causeHeader: false keeps the header off, and a success never carries one", async () => {
    const quiet = service("quiet", { causeHeader: false });
    const url = await serve(quiet.bb, (res) => {
      quiet.bb.captureException(new Error("boom"));
      res.statusCode = 500;
      res.end();
    });
    const ok = service("ok");
    const okUrl = await serve(ok.bb, (res) => {
      res.statusCode = 200;
      res.end();
    });
    const headers = { traceparent: TRACEPARENT };
    expect((await fetch(url, { headers })).headers.get(HEADER_CAUSE)).toBeNull();
    expect((await fetch(okUrl, { headers })).headers.get(HEADER_CAUSE)).toBeNull();
  });

  it("an unreported 5xx is recorded once, whether or not the caller was traced", async () => {
    const svc = service("svc");
    const url = await serve(svc.bb, (res) => {
      res.statusCode = 500;
      res.end();
    });
    const traced = await fetch(url, { headers: { traceparent: TRACEPARENT } });
    await fetch(url);
    const { deltas } = await folds();
    expect(deltas).toHaveLength(1); // same fingerprint from writeHead and from `finish`
    expect(deltas[0]!.count).toBe(2);
    expect(traced.headers.get(HEADER_CAUSE)).toBe(deltas[0]!.fingerprint);
  });

  it("an error captured before the downstream failure is not credited to it", () => {
    const ring = new RingBuffer<RawCapture>(1024 * 1024);
    const engine = createCaptureEngine({
      ring,
      sampler: createSampler({ error: 1, log: 1, span: 1 }),
      counters: createDropCounters(),
    });
    runWithContext({ traceId: TRACE, spanId: SPAN }, () => {
      engine.captureException(new Error("before"));
      noteDownstreamResponse({ status: 500, headers: { "x-bb-cause": FP } });
      engine.captureException(new Error("after"));
    });
    const [before, after] = ring.drain();
    expect(before!.causedBy).toBeUndefined();
    expect(after!.causedBy).toBe(FP);
  });
});
