import { describe, expect, it } from "vitest";
import { RingBuffer } from "../../src/ring-buffer.js";
import { createSampler } from "../../src/sampler.js";
import { createDropCounters } from "../../src/drop-counters.js";
import { createCaptureEngine } from "../../src/capture.js";
import type { RawCapture } from "../../src/raw-capture.js";

function harness(ringBytes = 1024 * 1024) {
  const ring = new RingBuffer<RawCapture>(ringBytes);
  const sampler = createSampler({ error: 1, log: 1, span: 1 });
  const counters = createDropCounters();
  const engine = createCaptureEngine({ ring, sampler, counters });
  return { ring, sampler, counters, engine };
}

describe("capture hot path", () => {
  it("captureException with a valid Error reaches the ring buffer at default (1.0) sample rate", () => {
    const { engine, ring } = harness();
    engine.captureException(new Error("boom"));
    expect(ring.length).toBe(1);
  });

  it("never throws for a table of valid representative inputs", () => {
    const { engine } = harness();
    class CustomError extends Error {}
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const deepStack = new Error("deep");
    deepStack.stack = Array.from(
      { length: 50 },
      (_, i) => `    at fn${i} (file${i}.ts:${i}:1)`,
    ).join("\n");

    expect(() => engine.captureException(new Error("plain"))).not.toThrow();
    expect(() => engine.captureException(new CustomError("custom"))).not.toThrow();
    expect(() => engine.captureException("a string, not an Error")).not.toThrow();
    expect(() => engine.captureException(deepStack)).not.toThrow();
    expect(() =>
      engine.captureException(new Error("has extra"), { release: "1.0.0" }),
    ).not.toThrow();
    // an unrelated circular object passed as `error` still must not throw
    expect(() => engine.captureException(circular)).not.toThrow();
  });

  it("increments dropped_buffer_full and does not throw or block when the ring is full", () => {
    const { engine, counters } = harness(1); // effectively zero capacity for any real capture
    expect(() => engine.captureException(new Error("no room"))).not.toThrow();
    expect(counters.droppedBufferFull).toBeGreaterThan(0);
  });

  it("keeps a valid log at directive rate 0.02 approximately 2% of the time over many trials", () => {
    const { ring, sampler, counters } = harness();
    sampler.updateRates({ log: 0.02 });
    const engine = createCaptureEngine({ ring, sampler, counters });
    const trials = 10_000;
    for (let i = 0; i < trials; i++) engine.captureMessage("noisy log line");
    const keptFraction = ring.length / trials;
    expect(keptFraction).toBeGreaterThan(0.01);
    expect(keptFraction).toBeLessThan(0.035);
  });

  it("recursion guard: a capture triggered synchronously from inside another capture (simulated logger -> SDK -> logger loop) is a no-op, not infinite recursion", () => {
    const { ring, counters } = harness();
    let reentrantCallCount = 0;
    // A sampler whose .keep() itself logs — the exact shape of a real logger-inside-the-SDK loop:
    // capture() calls sampler.keep(), which (in a hostile/misconfigured setup) calls capture()
    // again before the outer call has finished.
    const reentrantSampler = {
      keep(): boolean {
        reentrantCallCount++;
        if (reentrantCallCount === 1) {
          engine.captureException(new Error("nested, from inside sampler.keep()"));
        }
        return true;
      },
      updateRates() {},
      getRates: () => ({ error: 1, log: 1, span: 1 }),
    };
    const engine = createCaptureEngine({ ring, sampler: reentrantSampler, counters });

    expect(() => engine.captureException(new Error("outer"))).not.toThrow();
    // The guard means the nested call returned immediately without reaching the ring at all —
    // only the outer capture (which runs to completion after the guard resets) is recorded.
    expect(ring.length).toBe(1);
  });
});
