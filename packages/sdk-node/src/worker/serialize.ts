import type {
  BugBusterEvent,
  DropCounters,
  Envelope,
  EnvelopeItem,
  FoldDelta,
  LogEntry,
  LogLevel,
  Priority,
} from "@bugbusterhq/types";
import { encodeEnvelope, NEVER_SHED_PRIORITIES, splitIntoBatches } from "@bugbusterhq/types";

/**
 * Priority byte for a log line, per the shed ladder (envelope.ts): chatter goes first.
 * debug -> 0, info -> 1, warn/error -> 3 (same tier as aggregate counts — kept over info chatter
 * but, unlike a 5xx exemplar or a new fingerprint, still sheddable under real pressure).
 */
export function priorityForLog(level: LogLevel): Priority {
  if (level === "debug") return 0;
  if (level === "info") return 1;
  return 3;
}

/**
 * Splits log lines into batches of at most `maxBytes` of serialized JSON each (a single oversize
 * line still gets its own batch — it is never dropped here; the backend decides what to reject).
 *
 * Needed because the log path is the first thing in BugBuster whose volume per flush window is
 * unbounded by fingerprint cardinality: one 5-second window of a busy service can serialize to
 * far more than the backend's request-size limit (ingestMaxBodyBytes), and a single oversize POST
 * is rejected whole (413) — losing every line in it, including the errors.
 */
export function splitLogsIntoBatches(logs: readonly LogEntry[], maxBytes: number): LogEntry[][] {
  return splitIntoBatches(logs, maxBytes);
}

/**
 * Builds the typed Envelope from one flush cycle's fold deltas, exemplars, and drop-counter meta.
 * No compression happens here: compression is the Agent's job (ingest-pipeline.md §6.2 — the SDK's
 * entire job is "serialize, write to a Unix domain socket, forget"), not the SDK's. The actual
 * wire encoding (encodeEnvelope/decodeEnvelopeItems) lives in @bugbusterhq/types as the shared codec
 * every side of the transport uses — see packages/types/src/codec.ts.
 */
export function buildEnvelope(input: {
  deltas: FoldDelta[];
  exemplars: BugBusterEvent[];
  /**
   * Drop counters for this envelope. Omit on every envelope but the first of a flush: the Agent
   * and backend SUM the meta records they receive, so a repeated record over-reports drops.
   */
  meta?: DropCounters;
  sdkVersion: string;
  newFingerprints: ReadonlySet<string>;
  /** Fingerprints currently suppressed (§7.1) — their exemplars are dropped, counts are kept. */
  isSuppressed?: (fingerprint: string) => boolean;
  /** Raw log lines for this envelope — never folded; one `log` item each. */
  logs?: readonly LogEntry[];
}): Envelope {
  const items: EnvelopeItem[] = [];
  const suppressed = input.isSuppressed ?? (() => false);

  for (const delta of input.deltas) {
    items.push({
      type: "fold",
      priority: input.newFingerprints.has(delta.fingerprint) ? 9 : 3,
      payload: delta,
    });
  }

  for (const exemplar of input.exemplars) {
    if (suppressed(exemplar.fingerprint)) continue; // counts-only for this fingerprint right now
    const isNewFingerprint = input.newFingerprints.has(exemplar.fingerprint);
    const is5xx = exemplar.error?.code?.startsWith("5") ?? false;
    items.push({
      type: "exemplar",
      priority: isNewFingerprint || is5xx ? 9 : 2,
      payload: exemplar,
    });
  }

  for (const log of input.logs ?? []) {
    items.push({ type: "log", priority: priorityForLog(log.level), payload: log });
  }

  if (input.meta) items.push({ type: "meta", priority: 3, payload: input.meta });

  return { sentAt: new Date().toISOString(), sdkVersion: input.sdkVersion, items };
}

export { encodeEnvelope, NEVER_SHED_PRIORITIES };
