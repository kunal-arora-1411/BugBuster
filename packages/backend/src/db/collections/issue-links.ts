import type { AnyBulkWriteOperation, Collection, Db } from "mongodb";
import { CAUSE_FINGERPRINT_PATTERN } from "@bugbusterhq/types";

/**
 * Cause and effect between issues (docs/architecture/root-cause-graph.md §5): one document per
 * `(cause, effect)` pair, counting how many occurrences of `effect` followed a failure of `cause`
 * downstream, in the same request. Issues are the graph's nodes; these are its edges.
 */
export interface IssueLinkDocument {
  cause: string;
  effect: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export function issueLinksCollection(db: Db): Collection<IssueLinkDocument> {
  return db.collection<IssueLinkDocument>("issue_links");
}

export async function ensureIssueLinksIndexes(db: Db): Promise<void> {
  const links = issueLinksCollection(db);
  await links.createIndex({ cause: 1, effect: 1 }, { unique: true });
  await links.createIndex({ effect: 1, count: -1 }); // what caused this issue, strongest first
  await links.createIndex({ cause: 1, count: -1 }); // what this issue caused
}

/**
 * Adds one fold delta's `causedBy` counts to the graph: one atomic `$inc` upsert per pair, in one
 * round trip. Applied right after the delta's own fold upsert, so a retried envelope counts both
 * twice, consistently. A self-link, a malformed fingerprint, or a non-positive count is skipped:
 * folds come from SDKs this backend trusts, but a bad key must not become a node.
 */
export async function recordCauseLinks(
  db: Db,
  effect: string,
  causedBy: Record<string, number> | undefined,
): Promise<number> {
  if (!causedBy) return 0;
  const now = new Date().toISOString();
  const writes: AnyBulkWriteOperation<IssueLinkDocument>[] = [];
  for (const [cause, count] of Object.entries(causedBy)) {
    if (cause === effect || !CAUSE_FINGERPRINT_PATTERN.test(cause)) continue;
    if (!Number.isInteger(count) || count <= 0) continue;
    writes.push({
      updateOne: {
        filter: { cause, effect },
        update: { $inc: { count }, $set: { lastSeen: now }, $setOnInsert: { firstSeen: now } },
        upsert: true,
      },
    });
  }
  if (writes.length === 0) return 0;
  try {
    await issueLinksCollection(db).bulkWrite(writes, { ordered: false });
  } catch (err) {
    // Two first-ever writes of one pair can race on the unique index; the loser's pair exists
    // now, so replaying the batch applies it as a plain update (same reasoning as upsertFoldDelta).
    if ((err as { code?: number }).code !== 11000) throw err;
    await issueLinksCollection(db).bulkWrite(writes, { ordered: false });
  }
  return writes.length;
}

export interface LinkRow {
  cause: string;
  effect: string;
  count: number;
}

/**
 * Keeps only links whose other end is a real issue in this org. A fingerprint a caller heard in an
 * X-BB-Cause header may belong to a service reporting to another organization (or be stale); it
 * then names nothing here and must not show up as a cause.
 */
function onlyKnown(field: "cause" | "effect") {
  return [
    {
      $lookup: {
        from: "issues",
        localField: field,
        foreignField: "fingerprint",
        as: "_known",
        pipeline: [{ $project: { _id: 1 } }, { $limit: 1 }],
      },
    },
    { $match: { _known: { $ne: [] } } },
  ];
}

/** For each effect, its single strongest known cause (highest count). One aggregation per page. */
export async function strongestCauses(
  db: Db,
  effects: readonly string[],
): Promise<Map<string, LinkRow>> {
  if (effects.length === 0) return new Map();
  const rows = await issueLinksCollection(db)
    .aggregate<LinkRow>([
      { $match: { effect: { $in: [...effects] } } },
      ...onlyKnown("cause"),
      { $sort: { effect: 1, count: -1, cause: 1 } },
      { $group: { _id: "$effect", cause: { $first: "$cause" }, count: { $first: "$count" } } },
      { $project: { _id: 0, effect: "$_id", cause: 1, count: 1 } },
    ])
    .toArray();
  return new Map(rows.map((r) => [r.effect, r]));
}

/** Known links into (`causesOf`) or out of (`effectsOf`) one issue, strongest first. */
export async function linksOf(
  db: Db,
  direction: "causesOf" | "effectsOf",
  fingerprint: string,
  limit: number,
): Promise<LinkRow[]> {
  const causesOf = direction === "causesOf";
  return issueLinksCollection(db)
    .aggregate<LinkRow>([
      { $match: causesOf ? { effect: fingerprint } : { cause: fingerprint } },
      { $sort: { count: -1, [causesOf ? "cause" : "effect"]: 1 } },
      ...onlyKnown(causesOf ? "cause" : "effect"),
      { $limit: limit },
      { $project: { _id: 0, cause: 1, effect: 1, count: 1 } },
    ])
    .toArray();
}
