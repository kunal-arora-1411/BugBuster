import { randomUUID } from "node:crypto";
import type { BugBusterEvent, ServiceContext } from "@bugbuster/types";
import type { RawCapture } from "../raw-capture.js";
import { parseStack } from "./stack.js";
import { computeFingerprint } from "./fingerprint.js";
import { redactString } from "./redact.js";
import type { FoldTable, FoldRecordInput } from "./fold.js";

export interface PipelineDeps {
  foldTable: FoldTable;
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
  const fingerprint = computeFingerprint({ errorType, frames });

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
  };

  const input: FoldRecordInput = {
    fingerprint,
    isNewFingerprint,
    event,
    release: raw.release,
  };
  deps.foldTable.record(input);
}
