import type { LogLevel } from "@bugbusterhq/types";
import type { BugBusterContext } from "./context.js";

/**
 * What actually goes into the ring buffer: a reference to the raw input, not a serialized copy.
 * ingest-pipeline.md §3.2 — "never serialize on the hot path... push object references into the
 * ring; worker serializes." Stack access (`error.stack`) happens here because V8 formats it
 * lazily and caches the result on first read — deferring the read itself would just move the same
 * cost into the worker with no savings, but the *parsing* of that string into structured frames
 * still happens only in the worker (packages/sdk-node/src/worker/stack.ts).
 */
export type CaptureKind = "exception" | "message" | "log";

export interface RawCapture {
  kind: CaptureKind;
  error?: Error;
  message?: string;
  /** Only for `kind: "log"` — a raw, un-folded log line (see packages/types/src/log.ts). */
  level?: LogLevel;
  /** Only for `kind: "log"` — a SHALLOW COPY of the caller's fields, sanitized later in the worker. */
  fields?: Record<string, unknown>;
  context?: BugBusterContext;
  timestampMs: number;
  release?: string;
  environment?: string;
}
