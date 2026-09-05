import { bench, describe } from "vitest";
import { RingBuffer } from "../../src/ring-buffer.js";
import { createSampler } from "../../src/sampler.js";
import { createDropCounters } from "../../src/drop-counters.js";
import { createCaptureEngine } from "../../src/capture.js";
import type { RawCapture } from "../../src/raw-capture.js";

/**
 * Indicative, not gospel: these numbers depend on the machine running them, per
 * ingest-pipeline.md's own caveat on the <5µs/<50µs budgets. What matters is the SHAPE — a log
 * capture should be roughly an order of magnitude cheaper than an exception capture, because the
 * exception path pays for V8's stack formatting and the log path doesn't.
 *
 * Run with: pnpm --filter @bugbuster/sdk-node bench
 */

function harness() {
  const ring = new RingBuffer<RawCapture>(8 * 1024 * 1024);
  const sampler = createSampler({ error: 1, log: 1, span: 1 });
  const counters = createDropCounters();
  return createCaptureEngine({ ring, sampler, counters });
}

describe("hot path — target: log capture noticeably cheaper than exception capture", () => {
  const engine = harness();
  const preBuiltError = new Error("benchmark error");

  bench("captureMessage — budget target <5µs", () => {
    engine.captureMessage("benchmark log line");
  });

  bench("captureException (pre-built Error, stack already formatted) — budget target <50µs", () => {
    engine.captureException(preBuiltError);
  });

  bench(
    "captureException (fresh Error — pays V8's stack-formatting cost on first .stack access)",
    () => {
      engine.captureException(new Error("fresh"));
    },
  );
});
