import type { Db } from "mongodb";
import { decodeEnvelopeItems, LogEntrySchema, type LogEntry } from "@bugbusterhq/types";
import {
  addExemplarRef,
  removeExemplarRef,
  setIssueTitleIfMissing,
  titleFromEvent,
  upsertFoldDelta,
} from "../db/collections/issues.js";
import { insertExemplar } from "../db/collections/events.js";
import { insertLogs } from "../db/collections/logs.js";
import { recordCauseLinks } from "../db/collections/issue-links.js";

/**
 * The one place the JSON parse happens (ingest-pipeline.md §8.1's v1 nuance — see edge.ts).
 * Reads a validated org's raw envelope bytes, stores log lines, does the fold-merge upsert, and
 * stores exemplars.
 */
export interface ProcessResult {
  processedFolds: number;
  processedExemplars: number;
  /** Exemplars not stored: the issue already holds its cap of them, or storing one failed. */
  droppedExemplars: number;
  /** Log lines newly stored (a re-delivered duplicate of an already-stored line is not counted). */
  processedLogs: number;
  /** Log items that failed schema validation (or could not be serialized) and were discarded. */
  rejectedLogs: number;
  fingerprintsSeen: string[];
  /** Cause -> effect pairs added to (root-cause-graph.md §5). */
  processedLinks: number;
}

export async function processEnvelope(db: Db, rawBody: Buffer): Promise<ProcessResult> {
  const items = decodeEnvelopeItems(rawBody);
  const fingerprintsSeen = new Set<string>();
  let processedFolds = 0;
  let processedExemplars = 0;
  let droppedExemplars = 0;
  let processedLinks = 0;
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

  // Older SDKs send folds without the service; their example events in the same envelope carry it.
  const serviceOfEvent = new Map<string, string>();
  for (const item of items) {
    if (item.type === "exemplar")
      serviceOfEvent.set(item.payload.eventId, item.payload.service.name);
  }

  for (const item of items) {
    if (item.type === "fold") {
      const fold = item.payload;
      const service =
        fold.service ??
        fold.exemplars.map((id) => serviceOfEvent.get(id)).find((name) => name !== undefined);
      await upsertFoldDelta(db, service ? { ...fold, service } : fold);
      // The fold's cause links (root-cause-graph.md §5), right after the fold they belong to.
      processedLinks += await recordCauseLinks(db, fold.fingerprint, fold.causedBy);
      fingerprintsSeen.add(item.payload.fingerprint);
      processedFolds++;
    } else if (item.type === "exemplar") {
      fingerprintsSeen.add(item.payload.fingerprint);
      if (await storeExemplar(db, item.payload)) processedExemplars++;
      else droppedExemplars++;
    }
    // "meta" items (drop counters) are parsed but not yet persisted anywhere queryable — there is
    // no dashboard surface consuming them yet (that lands with M6). Not a named invariant this
    // milestone blocks on; a reasonable next addition once the dashboard needs it.
  }

  return {
    processedFolds,
    processedExemplars,
    droppedExemplars,
    processedLogs: stored.inserted,
    rejectedLogs,
    fingerprintsSeen: [...fingerprintsSeen],
    processedLinks,
  };
}

/**
 * Stores one exemplar if, and only if, its issue keeps it. The reference is claimed first (one
 * atomic, capped update) and the event written second, so an event past the issue's cap is never
 * written: before this, every exemplar the SDK sent was stored and only six were ever referenced,
 * leaving `events` to grow forever.
 *
 * Best-effort by design. This runs after the fold deltas have been applied, and a fold upsert is
 * not idempotent: if a failure here failed the request, the sender's retry would count every fold
 * twice. So a failure is absorbed (and the claimed reference released), never thrown.
 */
async function storeExemplar(db: Db, event: ExemplarPayload): Promise<boolean> {
  let claimed = false;
  try {
    claimed = await addExemplarRef(db, event.fingerprint, {
      eventId: event.eventId,
      role: event.exemplarRole,
    });
    if (!claimed) return false;
    await insertExemplar(db, event);
    // The first example an issue keeps also names it, so the issue list needs no extra reads.
    await setIssueTitleIfMissing(db, event.fingerprint, titleFromEvent(event)).catch(() => {});
    return true;
  } catch {
    if (claimed) await removeExemplarRef(db, event.fingerprint, event.eventId).catch(() => {});
    return false;
  }
}

type ExemplarPayload = Parameters<typeof insertExemplar>[1];
