import { describe, expect, it } from "vitest";
import { MAX_LOG_MESSAGE_CHARS } from "@bugbusterhq/types";
import { RingBuffer } from "../../src/ring-buffer.js";
import { createSampler } from "../../src/sampler.js";
import { createDropCounters } from "../../src/drop-counters.js";
import { createCaptureEngine } from "../../src/capture.js";
import type { RawCapture } from "../../src/raw-capture.js";
import { runWithContext } from "../../src/context.js";

function harness(
  opts: {
    ringBytes?: number;
    logBytes?: number;
    minLogLevel?: "debug" | "info" | "warn" | "error";
  } = {},
) {
  const ring = new RingBuffer<RawCapture>(opts.ringBytes ?? 1024 * 1024);
  const logRing = new RingBuffer<RawCapture>(opts.logBytes ?? 1024 * 1024);
  const sampler = createSampler({ error: 1, log: 1, span: 1 });
  const counters = createDropCounters();
  const engine = createCaptureEngine({
    ring,
    logRing,
    sampler,
    counters,
    minLogLevel: opts.minLogLevel,
  });
  return { ring, logRing, sampler, counters, engine };
}

describe("captureLog hot path", () => {
  it("records a log line into the LOG ring, not the exception ring", () => {
    const { engine, ring, logRing } = harness();
    engine.captureLog("info", "order placed", { orderId: "o_1" });
    expect(logRing.length).toBe(1);
    expect(ring.length).toBe(0);
    const [raw] = logRing.drain();
    expect(raw).toMatchObject({
      kind: "log",
      level: "info",
      message: "order placed",
      fields: { orderId: "o_1" },
    });
  });

  it("discards anything below minLogLevel before sampling or allocating", () => {
    const { engine, logRing, counters } = harness({ minLogLevel: "warn" });
    engine.captureLog("debug", "d");
    engine.captureLog("info", "i");
    engine.captureLog("warn", "w");
    engine.captureLog("error", "e");
    expect(logRing.length).toBe(2);
    // a level filter is configuration, not a drop: it must not pollute the drop counters
    expect(counters.sampledOut).toBe(0);
    expect(counters.droppedBufferFull).toBe(0);
  });

  it("defaults minLogLevel to info (debug is dropped, info kept)", () => {
    const { engine, logRing } = harness();
    engine.captureLog("debug", "chatter");
    engine.captureLog("info", "kept");
    expect(logRing.length).toBe(1);
  });

  it("rejects an unknown level from an untyped caller without throwing", () => {
    const { engine, logRing } = harness();
    expect(() => engine.captureLog("fatal" as never, "x")).not.toThrow();
    expect(logRing.length).toBe(0);
  });

  it("rejects Object.prototype names as levels (no inherited lookup)", () => {
    const { engine, logRing } = harness({ minLogLevel: "debug" });
    for (const level of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      engine.captureLog(level as never, "x");
      expect(engine.isLogLevelEnabled(level as never)).toBe(false);
    }
    expect(logRing.length).toBe(0);
  });

  it("isLogLevelEnabled mirrors minLogLevel", () => {
    const { engine } = harness({ minLogLevel: "warn" });
    expect(
      ["debug", "info", "warn", "error"].map((l) => engine.isLogLevelEnabled(l as never)),
    ).toEqual([false, false, true, true]);
  });

  it("obeys the backend's per-type sample rate for logs, independently of errors", () => {
    const { engine, sampler, ring, logRing, counters } = harness();
    sampler.updateRates({ log: 0 });
    engine.captureLog("info", "sampled out");
    engine.captureException(new Error("still kept"));
    expect(logRing.length).toBe(0);
    expect(ring.length).toBe(1);
    expect(counters.sampledOut).toBe(1);
  });

  it("a log flood fills only the log ring — the next exception is NOT dropped", () => {
    const { engine, ring, logRing, counters } = harness({ logBytes: 4096 });
    for (let i = 0; i < 1000; i++) engine.captureLog("info", `line ${i}`);
    expect(logRing.length).toBeLessThan(1000);
    expect(counters.droppedBufferFull).toBeGreaterThan(0);

    const droppedBefore = counters.droppedBufferFull;
    engine.captureException(new Error("the one that matters"));
    expect(ring.length).toBe(1);
    expect(counters.droppedBufferFull).toBe(droppedBefore); // the exception cost no drop
  });

  it("counts a drop (never blocks, never throws) when the log ring is full", () => {
    const { engine, counters } = harness({ logBytes: 300 });
    expect(() => {
      for (let i = 0; i < 50; i++) engine.captureLog("info", "x".repeat(50));
    }).not.toThrow();
    expect(counters.droppedBufferFull).toBeGreaterThan(0);
  });

  it("truncates an enormous message at capture time to bound retained memory", () => {
    const { engine, logRing } = harness();
    engine.captureLog("info", "z".repeat(MAX_LOG_MESSAGE_CHARS * 10));
    const [raw] = logRing.drain();
    expect(raw?.message?.length).toBe(MAX_LOG_MESSAGE_CHARS);
  });

  it("snapshots fields shallowly so later mutation by the caller cannot change the record", () => {
    const { engine, logRing } = harness();
    const fields: Record<string, unknown> = { status: "pending" };
    engine.captureLog("info", "x", fields);
    fields.status = "mutated-after";
    const [raw] = logRing.drain();
    expect(raw?.fields?.status).toBe("pending");
  });

  it("attaches the ambient trace context when one is active, and none when it is not", () => {
    const { engine, logRing } = harness();
    runWithContext({ traceId: "trace-1", spanId: "span-1" }, () =>
      engine.captureLog("info", "in request"),
    );
    engine.captureLog("info", "background job");
    const [inReq, bg] = logRing.drain();
    expect(inReq?.context).toMatchObject({ traceId: "trace-1", spanId: "span-1" });
    expect(bg?.context).toBeUndefined();
  });

  it("never throws for hostile input (circular fields, non-string message, null fields)", () => {
    const { engine } = harness();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => engine.captureLog("info", "c", circular)).not.toThrow();
    expect(() => engine.captureLog("info", 42 as never)).not.toThrow();
    expect(() => engine.captureLog("info", "n", null as never)).not.toThrow();
    expect(() =>
      engine.captureLog("info", {
        toString: () => {
          throw new Error("x");
        },
      } as never),
    ).not.toThrow();
  });

  it("falls back to the shared ring when no dedicated log ring is supplied (back-compat)", () => {
    const ring = new RingBuffer<RawCapture>(1024 * 1024);
    const engine = createCaptureEngine({
      ring,
      sampler: createSampler({ error: 1, log: 1, span: 1 }),
      counters: createDropCounters(),
    });
    engine.captureLog("info", "hello");
    expect(ring.length).toBe(1);
  });
});
