import { ObjectId, type Db } from "mongodb";

/**
 * Exemplars ("events") that no issue references can never be shown: the Query API only reads
 * events through an issue's `exemplarRefs`. Before the processor stopped writing exemplars past an
 * issue's cap, every exemplar the SDK sent was stored, so existing databases hold many of these.
 *
 * Only events written more than `minAgeMs` ago are considered. Ingest claims an exemplar's
 * reference a moment before it writes the event; an event younger than that window may belong to
 * a reference this scan did not see yet, so it is left alone. The age comes from the event's own
 * `_id` (an ObjectId records when it was created), because the event's `timestamp` is the
 * client's clock, not ours.
 */
export const ORPHAN_MIN_AGE_MS = 10 * 60 * 1000;

function orphanFilter(referenced: string[], minAgeMs: number, now: Date): Record<string, unknown> {
  const cutoff = ObjectId.createFromTime(Math.floor((now.getTime() - minAgeMs) / 1000));
  return { eventId: { $nin: referenced }, _id: { $lt: cutoff } };
}

async function referencedEventIds(db: Db): Promise<string[]> {
  return (await db.collection("issues").distinct("exemplarRefs.eventId")) as string[];
}

/** How many unreferenced events are old enough to delete. Read-only. */
export async function countUnreferencedEvents(
  db: Db,
  opts: { minAgeMs?: number; now?: Date } = {},
): Promise<number> {
  const filter = orphanFilter(
    await referencedEventIds(db),
    opts.minAgeMs ?? ORPHAN_MIN_AGE_MS,
    opts.now ?? new Date(),
  );
  return db.collection("events").countDocuments(filter);
}

/** Deletes unreferenced events older than the safety window. Safe to run repeatedly. */
export async function deleteUnreferencedEvents(
  db: Db,
  opts: { minAgeMs?: number; now?: Date } = {},
): Promise<number> {
  const filter = orphanFilter(
    await referencedEventIds(db),
    opts.minAgeMs ?? ORPHAN_MIN_AGE_MS,
    opts.now ?? new Date(),
  );
  return (await db.collection("events").deleteMany(filter)).deletedCount;
}
