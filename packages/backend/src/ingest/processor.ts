import type { Db } from "mongodb";
import { decodeEnvelopeItems, LogEntrySchema, type LogEntry } from "@bugbusterhq/types";
import { addExemplarRef, upsertFoldDelta } from "../db/collections/issues.js";
import { insertExemplar } from "../db/collections/events.js";
import { insertLogs } from "../db/collections/logs.js";

/**
 * The one place the JSON parse happens (ingest-pipeline.md §8.1's v1 nuance — see edge.ts).
 * Reads a validated org's raw envelope bytes, stores log lines, does the fold-merge upsert, and
 * stores exemplars.
 */
export interface ProcessResult {
  processedFolds: number;
  processedExemplars: number;
  /** Log lines newly stored (a re-delivered duplicate of an already-stored line is not counted). */
  processedLogs: number;
  /** Log items that failed schema validation (or could not be serialized) and were discarded. */
  rejectedLogs: number;
  fingerprintsSeen: string[];
}

export async function processEnvelope(db: Db, rawBody: Buffer): Promise<ProcessResult> {
  const items = decodeEnvelopeItems(rawBody);
  const fingerprintsSeen = new Set<string>();
  let processedFolds = 0;
  let processedExemplars = 0;
  const validLogs: LogEntry[] = [];
  let rejectedLogs = 0;

  // Logs are validated and stored FIRST, before any fold is applied. A fold upsert is an increment
  // and is not idempotent, so nothing that can still fail the request may run after it: if a log
  // insert failed after the folds landed, the 500 would make the sender retry the whole envelope
  // and every fold would be counted twice. Log inserts are idempotent (unique `logId`), so a
  // failure here followed by a retry is harmless.
  for (const item of items) {
    if (item.type !== "log") continue;
    // Unlike folds/exemplars (which the SDK produces and this processor trusts), log lines are
    // stored as-is and later served back to users — so each one is validated against the schema
    // here. A malformed line is dropped; it must never poison the batch or the collection.
    const parsed = LogEntrySchema.safeParse(item.payload);
    if (parsed.success) validLogs.push(parsed.data);
    else rejectedLogs++;
  }
  // One bulk insert for the whole batch rather than a round trip per line: a busy flush window
  // carries hundreds of lines, and the folds below are per-fingerprint (a handful), not per-line.
  const stored = await insertLogs(db, validLogs);
  rejectedLogs += stored.rejected;

  for (const item of items) {
    if (item.type === "fold") {
      await upsertFoldDelta(db, item.payload);
      fingerprintsSeen.add(item.payload.fingerprint);
      processedFolds++;
    } else if (item.type === "exemplar") {
      await insertExemplar(db, item.payload);
      await addExemplarRef(db, item.payload.fingerprint, {
        eventId: item.payload.eventId,
        role: item.payload.exemplarRole,
      });
      fingerprintsSeen.add(item.payload.fingerprint);
      processedExemplars++;
    }
    // "meta" items (drop counters) are parsed but not yet persisted anywhere queryable — there is
    // no dashboard surface consuming them yet (that lands with M6). Not a named invariant this
    // milestone blocks on; a reasonable next addition once the dashboard needs it.
  }

  return {
    processedFolds,
    processedExemplars,
    processedLogs: stored.inserted,
    rejectedLogs,
    fingerprintsSeen: [...fingerprintsSeen],
  };
}
