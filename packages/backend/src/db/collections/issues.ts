import { MongoServerError, type Collection, type Db } from "mongodb";
import type { ExemplarRef, FoldDelta, Issue } from "@bugbuster/types";

const DUPLICATE_KEY_ERROR_CODE = 11000;

/**
 * The internal storage shape differs from the public `Issue` wire shape (@bugbuster/types) by
 * design: `usersAffected`, `duration`, and `topEndpoints` are DERIVED fields in the public shape
 * (ingest-pipeline.md §4.2 — exact for v1, sketch-shaped later). To derive them exactly, the
 * document itself must hold the raw ingredients — the deduplicated user-ID set, the raw duration
 * samples, and the raw per-endpoint counts — because an exact union/percentile/top-K can only be
 * computed from the underlying values, not reconstructed from an already-summarized number.
 *
 * `durationSamplesMs` is capped at the most recent MAX_DURATION_SAMPLES via `$push`+`$slice` — a
 * bounded, honestly-approximate v1 choice (percentiles reflect recent behavior, not the issue's
 * entire lifetime) rather than an unbounded array. At pilot volume this cap is rarely if ever hit.
 */
export interface IssueDocument {
  fingerprint: string;
  count: number;
  userIdSet: string[];
  endpointCounts: Record<string, number>;
  durationSamplesMs: number[];
  releases: string[];
  firstSeen: string;
  lastSeen: string;
  exemplarRefs: ExemplarRef[];
  adjustedCount: number;
}

const MAX_DURATION_SAMPLES = 1000;
const TOP_K = 20;

function issuesCollection(db: Db): Collection<IssueDocument> {
  return db.collection<IssueDocument>("issues");
}

export async function ensureIssuesIndexes(db: Db): Promise<void> {
  await issuesCollection(db).createIndex({ fingerprint: 1 }, { unique: true });
  await issuesCollection(db).createIndex({ lastSeen: -1 });
}

// Mongo field names historically disallowed literal dots; endpoint paths commonly contain
// slashes but rarely dots, so this is a narrow, documented sanitization rather than a general one.
function sanitizeEndpointKey(endpoint: string): string {
  return endpoint.replace(/\./g, "_");
}

/**
 * The atomic fold-merge upsert — the mechanic the fold's "no lost updates under concurrent
 * writers" guarantee depends on entirely. One `updateOne` call, one round trip, no read-modify-
 * write race: `$inc` and `$addToSet` are applied server-side, atomically, per document.
 */
export async function upsertFoldDelta(db: Db, delta: FoldDelta): Promise<void> {
  const now = new Date().toISOString();
  const endpointEntries = Object.entries(delta.endpointCounts);

  const inc: Record<string, number> = { count: delta.count };
  for (const [endpoint, count] of endpointEntries) {
    inc[`endpointCounts.${sanitizeEndpointKey(endpoint)}`] = count;
  }

  // $inc on a dotted path (e.g. "endpointCounts.checkout") auto-vivifies `endpointCounts` as an
  // object on insert — but when this delta touches NO endpoint at all, $inc never mentions
  // `endpointCounts`, so nothing creates the field, and it would be missing on a fresh document.
  // $setOnInsert can't unconditionally default it to {} either: MongoDB rejects an update that
  // targets both a dotted child path ("endpointCounts.checkout") and its parent ("endpointCounts")
  // in the same operation as a path conflict. So the default only applies in the one case where
  // no such conflict is possible — when there are no endpoint keys this call touches at all.
  const setOnInsert: Record<string, unknown> = {
    firstSeen: now,
    exemplarRefs: [],
    adjustedCount: 1.0,
  };
  if (endpointEntries.length === 0) {
    setOnInsert.endpointCounts = {};
  }

  const update = {
    $inc: inc,
    $addToSet: {
      userIdSet: { $each: delta.userIds },
      releases: { $each: delta.release ? [delta.release] : [] },
    },
    $push: {
      durationSamplesMs: { $each: delta.durationSamplesMs, $slice: -MAX_DURATION_SAMPLES },
    },
    $set: { lastSeen: now },
    $setOnInsert: setOnInsert,
  };

  try {
    await issuesCollection(db).updateOne({ fingerprint: delta.fingerprint }, update, {
      upsert: true,
    });
  } catch (err) {
    // Two concurrent upserts can both see "no matching document" and both attempt an insert;
    // the unique index on `fingerprint` lets exactly one succeed and the other gets a duplicate
    // key error. By the time that happens, the document now exists, so retrying as a plain
    // (non-racing) update applies the same $inc/$addToSet/$push correctly — without this retry,
    // that occurrence's count is silently lost under concurrent writers.
    if (err instanceof MongoServerError && err.code === DUPLICATE_KEY_ERROR_CODE) {
      await issuesCollection(db).updateOne({ fingerprint: delta.fingerprint }, update, {
        upsert: true,
      });
      return;
    }
    throw err;
  }
}

/** Adds one exemplar reference, enforcing the ≤6-per-issue cap (ingest-pipeline.md §4.1). */
export async function addExemplarRef(
  db: Db,
  fingerprint: string,
  ref: ExemplarRef,
  maxExemplars = 6,
): Promise<void> {
  const doc = await issuesCollection(db).findOne(
    { fingerprint },
    { projection: { exemplarRefs: 1 } },
  );
  const existing = doc?.exemplarRefs ?? [];
  if (existing.some((e) => e.eventId === ref.eventId)) return; // already recorded
  if (existing.length >= maxExemplars) return; // at cap — the 7th (and beyond) is not stored
  await issuesCollection(db).updateOne({ fingerprint }, { $push: { exemplarRefs: ref } });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx] ?? 0;
}

function toPublicIssue(doc: IssueDocument): Issue {
  // Defensive defaults: a document should always have these fields (upsertFoldDelta guarantees
  // it), but the read path degrading gracefully on an unexpected shape is cheap insurance against
  // a 500 on an otherwise-valid request — matching the project's "never throw" ethos on writes.
  const sortedDurations = [...(doc.durationSamplesMs ?? [])].sort((a, b) => a - b);
  const endpointEntries = Object.entries(doc.endpointCounts ?? {}).sort((a, b) => b[1] - a[1]);
  const top = endpointEntries.slice(0, TOP_K).map(([endpoint, count]) => ({ endpoint, count }));
  const other = endpointEntries.slice(TOP_K).reduce((sum, [, count]) => sum + count, 0);

  return {
    fingerprint: doc.fingerprint,
    count: doc.count,
    usersAffected: (doc.userIdSet ?? []).length,
    duration: {
      p50: percentile(sortedDurations, 0.5),
      p95: percentile(sortedDurations, 0.95),
      p99: percentile(sortedDurations, 0.99),
    },
    topEndpoints: { top, other },
    releases: doc.releases,
    firstSeen: doc.firstSeen,
    lastSeen: doc.lastSeen,
    exemplarRefs: doc.exemplarRefs,
    adjustedCount: doc.adjustedCount,
  };
}

export async function listIssues(db: Db, limit = 50): Promise<Issue[]> {
  const docs = await issuesCollection(db).find({}).sort({ lastSeen: -1 }).limit(limit).toArray();
  return docs.map(toPublicIssue);
}

export async function getIssue(db: Db, fingerprint: string): Promise<Issue | undefined> {
  const doc = await issuesCollection(db).findOne({ fingerprint });
  return doc ? toPublicIssue(doc) : undefined;
}
