import type { RingBuffer } from "./ring-buffer.js";
import type { Sampler } from "./sampler.js";
import type { DropCountersHandle } from "./drop-counters.js";
import { getCurrentContext } from "./context.js";
import type { RawCapture } from "./raw-capture.js";

/**
 * The hot path (ingest-pipeline.md §3). Runs on every request in the host application. Every rule
 * here exists because it was identified as a non-negotiable in §3.1 — the comments below name
 * which one.
 */
export interface CaptureEngine {
  captureException(error: unknown, extra?: { release?: string; environment?: string }): void;
  captureMessage(message: string, extra?: { release?: string; environment?: string }): void;
}

export interface CaptureEngineDeps {
  ring: RingBuffer<RawCapture>;
  sampler: Sampler;
  counters: DropCountersHandle;
}

// A module-level flag, not per-instance: recursion can happen across any two CaptureEngine calls
// on the same thread (e.g. an app-level logger wraps captureException, and something inside this
// module ever logged through that same logger — the guard must be global to the thread, matching
// ingest-pipeline.md §3.1 rule 4's `in_capture` thread-local).
let inCapture = false;

// A conservative flat estimate rather than JSON.stringify: stringifying is exactly the "never
// serialize on the hot path" mistake (§3.2), and a raw capture holding a live Error object can
// contain circular references JSON.stringify would throw on anyway. The worker computes the real
// size once it actually serializes (worker/serialize.ts); this estimate only has to be good
// enough for byte-budget accounting, not exact.
const APPROX_BYTES_PER_CAPTURE = 2048;

export function createCaptureEngine(deps: CaptureEngineDeps): CaptureEngine {
  function capture(
    kind: RawCapture["kind"],
    payload: Pick<RawCapture, "error" | "message">,
    extra?: { release?: string; environment?: string },
  ): void {
    // Rule 4: recursion guard — logger -> SDK -> logger loops must not recurse.
    if (inCapture) {
      return;
    }
    inCapture = true;
    try {
      const sampleKind = kind === "exception" ? "error" : "log";
      if (!deps.sampler.keep(sampleKind)) {
        deps.counters.sampledOut++;
        return;
      }

      const raw: RawCapture = {
        kind,
        ...payload,
        context: getCurrentContext(),
        timestampMs: Date.now(),
        release: extra?.release,
        environment: extra?.environment,
      };

      const accepted = deps.ring.claim(raw, APPROX_BYTES_PER_CAPTURE);
      if (!accepted) {
        // Rule 2/3: never block, never grow past the byte cap — drop and count instead.
        deps.counters.droppedBufferFull++;
      }
      deps.counters.bufferHighWaterBytes = Math.max(
        deps.counters.bufferHighWaterBytes,
        deps.ring.usedBytes,
      );
    } finally {
      inCapture = false;
    }
  }

  return {
    // Rule 1: never throw into user code. try/catch wraps the entire body; any unexpected
    // internal failure (a hostile `extra` object, a pathological Error subclass) is swallowed,
    // not surfaced — a telemetry SDK that can crash the app is worse than no telemetry.
    captureException(error, extra) {
      try {
        const err = error instanceof Error ? error : new Error(String(error));
        capture("exception", { error: err }, extra);
      } catch {
        // swallowed by design — see rule 1 above
      }
    },
    captureMessage(message, extra) {
      try {
        capture("message", { message }, extra);
      } catch {
        // swallowed by design — see rule 1 above
      }
    },
  };
}
