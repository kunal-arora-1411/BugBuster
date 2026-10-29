import { LOG_LEVEL_ORDER, MAX_LOG_MESSAGE_CHARS, type LogLevel } from "@bugbusterhq/types";
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
  /**
   * Records one application log line — never folded, never fingerprinted (see
   * packages/types/src/log.ts for why). `fields` is structured context ({ orderId, userId, ... });
   * it is shallow-copied here and sanitized (JSON-safe, redacted, size-capped) off the hot path.
   * Anything below the configured `minLogLevel` is discarded immediately.
   */
  captureLog(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
}

export interface CaptureEngineDeps {
  ring: RingBuffer<RawCapture>;
  /**
   * A SEPARATE byte-capped buffer for log lines. Logs are orders of magnitude more frequent than
   * exceptions; if they shared `ring`, a chatty hour of `info` lines could fill it and the next
   * real exception would be the thing dropped. Optional only so older callers/tests that build an
   * engine by hand keep working — they fall back to sharing `ring`.
   */
  logRing?: RingBuffer<RawCapture>;
  /** Lowest severity recorded as a log line. Defaults to "info". */
  minLogLevel?: LogLevel;
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

// Logs are accounted by (cheap) size rather than a flat 2 KB: a typical request-log line is a few
// hundred bytes, and a flat 2 KB would make the log buffer hold ~5x fewer lines than it really can.
// `string.length` is O(1); this stays well inside the hot-path budget. Fields get a flat allowance
// because walking them to measure would be exactly the work §3.2 says belongs in the worker.
const LOG_BASE_BYTES = 200;
const LOG_FIELDS_ALLOWANCE_BYTES = 512;

export function createCaptureEngine(deps: CaptureEngineDeps): CaptureEngine {
  // Guards the common footgun of auto-instrumentation layered over manual calls (e.g. a
  // console.error hook AND an explicit captureException(err) firing for the same thrown error
  // within one request) — the same Error OBJECT captured twice must count once, not twice.
  // WeakSet so a long-lived process never retains errors past their own lifetime.
  const seenErrors = new WeakSet<object>();

  const minLogOrder = LOG_LEVEL_ORDER[deps.minLogLevel ?? "info"];
  const logRing = deps.logRing ?? deps.ring;

  function capture(
    kind: RawCapture["kind"],
    payload: Pick<RawCapture, "error" | "message" | "level" | "fields">,
    extra?: { release?: string; environment?: string },
    approxBytes = APPROX_BYTES_PER_CAPTURE,
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

      const target = kind === "log" ? logRing : deps.ring;
      const raw: RawCapture = {
        kind,
        ...payload,
        context: getCurrentContext(),
        timestampMs: Date.now(),
        release: extra?.release,
        environment: extra?.environment,
      };

      const accepted = target.claim(raw, approxBytes);
      if (!accepted) {
        // Rule 2/3: never block, never grow past the byte cap — drop and count instead.
        deps.counters.droppedBufferFull++;
      }
      deps.counters.bufferHighWaterBytes = Math.max(
        deps.counters.bufferHighWaterBytes,
        target.usedBytes,
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
        if (typeof error === "object" && error !== null) {
          if (seenErrors.has(error)) return;
          seenErrors.add(error);
        }
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
    captureLog(level, message, fields) {
      try {
        // The cheapest possible rejection comes first — before the recursion guard, before the
        // sampler's Math.random(), before any allocation. A `debug` call in a production service
        // (minLogLevel "info") must cost one lookup and one compare, nothing more. An unknown
        // level from an untyped caller yields `undefined`, which is also rejected here.
        const order = LOG_LEVEL_ORDER[level];
        if (order === undefined || order < minLogOrder) return;

        let text = typeof message === "string" ? message : String(message);
        // Bound retained memory up front: a 5 MB string logged by mistake must not sit in the
        // buffer until the next flush. V8 slices are O(1), so this is within budget.
        if (text.length > MAX_LOG_MESSAGE_CHARS) text = text.slice(0, MAX_LOG_MESSAGE_CHARS);

        // Shallow copy: the caller may mutate or reuse `fields` before the deferred flush runs.
        // Deep sanitization (and any nested mutation protection) happens in the worker.
        const copied =
          fields !== undefined && fields !== null && typeof fields === "object"
            ? { ...fields }
            : undefined;

        const approxBytes =
          LOG_BASE_BYTES +
          text.length * 2 +
          (copied !== undefined ? LOG_FIELDS_ALLOWANCE_BYTES : 0);
        capture("log", { message: text, level, fields: copied }, undefined, approxBytes);
      } catch {
        // swallowed by design — see rule 1 above
      }
    },
  };
}
