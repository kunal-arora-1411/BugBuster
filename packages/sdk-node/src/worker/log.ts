import type { LogEntry, ServiceContext } from "@bugbusterhq/types";
import type { RawCapture } from "../raw-capture.js";
import { redactString } from "./redact.js";
import { sanitizeFields } from "./sanitize-fields.js";

// A per-process counter makes ids from this process strictly increasing in write order, even for
// lines logged within the same millisecond (a tight loop easily writes dozens per ms).
let sequence = 0;

/**
 * A time-sortable log id: 12 hex chars of epoch-ms, a 6-hex per-process sequence, 8 hex random.
 * Fixed width, so plain string comparison orders ids by (time, write order).
 *
 * Why not a random UUID: the backend sorts newest-first by (timestamp, logId). With random ids,
 * lines written in the same millisecond come back in arbitrary order — which scrambles exactly the
 * cause-then-effect sequence a person reads logs for. Observed on the real stack: a debug, info,
 * warn, error sequence logged back to back was returned out of order. The trailing random part
 * keeps ids unique across processes that log in the same millisecond with the same sequence value.
 */
export function newLogId(timestampMs: number): string {
  sequence = (sequence + 1) % 0x1000000;
  const rand = Math.floor(Math.random() * 0x100000000);
  return (
    Math.max(0, Math.trunc(timestampMs)).toString(16).padStart(12, "0") +
    "-" +
    sequence.toString(16).padStart(6, "0") +
    "-" +
    rand.toString(16).padStart(8, "0")
  );
}

/**
 * One raw log capture -> one wire-ready `LogEntry`. The log-path counterpart of `processCapture`
 * (pipeline.ts), and deliberately much simpler: no stack parsing, no fingerprint, no fold table —
 * a log line is its own record. Off the hot path, same deferred-flush pass as everything else.
 */
export function buildLogEntry(raw: RawCapture, service: ServiceContext): LogEntry {
  const fields = sanitizeFields(raw.fields);
  return {
    logId: newLogId(raw.timestampMs),
    timestamp: new Date(raw.timestampMs).toISOString(),
    level: raw.level ?? "info",
    message: redactString(raw.message ?? ""),
    ...(fields !== undefined ? { fields } : {}),
    ...(raw.context ? { trace: { traceId: raw.context.traceId, spanId: raw.context.spanId } } : {}),
    service,
  };
}
