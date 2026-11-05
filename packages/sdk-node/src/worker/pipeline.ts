import { randomUUID } from "node:crypto";
import type { BugBusterEvent, ServiceContext } from "@bugbusterhq/types";
import type { RawCapture } from "../raw-capture.js";
import { parseStack } from "./stack.js";
import { computeFingerprint } from "./fingerprint.js";
import { redactString } from "./redact.js";
import type { FoldTable, FoldRecordInput } from "./fold.js";

export interface PipelineDeps {
  foldTable: FoldTable;
  /**
   * Fingerprints already computed for an error while the request was still running (to name it
   * in an X-BB-Cause response header — see fingerprintOfError). Reused here so that work is moved
   * earlier, never done twice.
   */
  fingerprintCache?: WeakMap<Error, string>;
  seenFingerprints: Set<string>;
  /** Populated (not read) here — fingerprints that became new during THIS processing pass. */
  newFingerprintsThisFlush: Set<string>;
  serviceContext: ServiceContext;
}

/**
 * One raw capture, fully processed: stack parsed, fingerprinted, redacted, and recorded into the
 * fold table. This is the off-hot-path work ingest-pipeline.md §3.2 describes as belonging to a
 * worker. See packages/sdk-node/README.md's "Known simplifications" for why v1 runs this
 * deferred-but-same-thread rather than in a literal node:worker_threads Worker.
 */
export function processCapture(raw: RawCapture, deps: PipelineDeps): void {
  const frames = raw.error ? parseStack(raw.error.stack) : [];
  const errorType = raw.error?.name ?? (raw.kind === "message" ? "Message" : "Error");
  const fingerprint =
    (raw.error ? deps.fingerprintCache?.get(raw.error) : undefined) ??
    computeFingerprint({
      errorType,
      frames,
      service: deps.serviceContext.name,
    });

  const isNewFingerprint = !deps.seenFingerprints.has(fingerprint);
  if (isNewFingerprint) {
    deps.seenFingerprints.add(fingerprint);
    deps.newFingerprintsThisFlush.add(fingerprint);
  }

  const primaryFrame = frames[0];
  const event: BugBusterEvent = {
    eventId: randomUUID(),
    fingerprint,
    exemplarRole: "first", // overwritten by FoldTable.drain()'s real role assignment
    timestamp: new Date(raw.timestampMs).toISOString(),
    type: raw.kind === "exception" ? "exception" : "message",
    trace: raw.context
      ? {
          traceId: raw.context.traceId,
          spanId: raw.context.spanId,
          parentSpanId: raw.context.parentSpanId,
        }
      : { traceId: randomUUID(), spanId: randomUUID() },
    service: deps.serviceContext,
    source: primaryFrame
      ? { function: primaryFrame.function, file: primaryFrame.file, line: primaryFrame.line }
      : { function: "<unknown>", file: "<unknown>", line: 0 },
    error:
      raw.error !== undefined
        ? {
            type: errorType,
            message: redactString(raw.error.message ?? ""),
            stacktrace: redactString(raw.error.stack ?? ""),
          }
        : raw.message !== undefined
          ? { type: "Message", message: redactString(raw.message), stacktrace: "" }
          : undefined,
    ...(raw.causedBy && raw.causedBy !== fingerprint ? { causedBy: raw.causedBy } : {}),
  };

  const input: FoldRecordInput = {
    fingerprint,
    isNewFingerprint,
    event,
    release: raw.release,
    causedBy: event.causedBy,
  };
  deps.foldTable.record(input);
}

/**
 * The fingerprint an error will be folded under, computed now and remembered in `cache` — for
 * naming the error in an X-BB-Cause response header while its request is still being answered.
 * Produces exactly what processCapture would (same parse, same material).
 */
export function fingerprintOfError(
  error: Error,
  service: string,
  cache: WeakMap<Error, string>,
): string {
  const cached = cache.get(error);
  if (cached !== undefined) return cached;
  const fingerprint = computeFingerprint({
    errorType: error.name ?? "Error",
    frames: parseStack(error.stack),
    service,
  });
  cache.set(error, fingerprint);
  return fingerprint;
}
