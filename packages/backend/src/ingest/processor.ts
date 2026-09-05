import type { Db } from "mongodb";
import { decodeEnvelopeItems } from "@bugbuster/types";
import { addExemplarRef, upsertFoldDelta } from "../db/collections/issues.js";
import { insertExemplar } from "../db/collections/events.js";

/**
 * The one place the JSON parse happens (ingest-pipeline.md §8.1's v1 nuance — see edge.ts).
 * Reads a validated org's raw envelope bytes, does the fold-merge upsert, and stores exemplars.
 */
export interface ProcessResult {
  processedFolds: number;
  processedExemplars: number;
  fingerprintsSeen: string[];
}

export async function processEnvelope(db: Db, rawBody: Buffer): Promise<ProcessResult> {
  const items = decodeEnvelopeItems(rawBody);
  const fingerprintsSeen = new Set<string>();
  let processedFolds = 0;
  let processedExemplars = 0;

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

  return { processedFolds, processedExemplars, fingerprintsSeen: [...fingerprintsSeen] };
}
