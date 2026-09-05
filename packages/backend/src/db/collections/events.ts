import type { Collection, Db } from "mongodb";
import type { BugBusterEvent } from "@bugbuster/types";

/** Individual raw exemplar payloads (§8.4) — capped per-issue by the caller (issues.ts's exemplar
 * cap check), not by this collection itself. Stores the full-fidelity doc.md-shaped event. */
function eventsCollection(db: Db): Collection<BugBusterEvent> {
  return db.collection<BugBusterEvent>("events");
}

export async function ensureEventsIndexes(db: Db): Promise<void> {
  await eventsCollection(db).createIndex({ fingerprint: 1 });
  await eventsCollection(db).createIndex({ eventId: 1 }, { unique: true });
}

export async function insertExemplar(db: Db, event: BugBusterEvent): Promise<void> {
  await eventsCollection(db).updateOne(
    { eventId: event.eventId },
    { $setOnInsert: event },
    { upsert: true }, // idempotent: a retried send must not duplicate the exemplar
  );
}

export async function getExemplarsByIds(
  db: Db,
  eventIds: readonly string[],
): Promise<BugBusterEvent[]> {
  if (eventIds.length === 0) return [];
  return eventsCollection(db)
    .find({ eventId: { $in: [...eventIds] } })
    .toArray();
}
