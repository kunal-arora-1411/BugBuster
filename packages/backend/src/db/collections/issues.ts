import { MongoServerError, type Collection, type Db, type Filter } from "mongodb";
import {
  ISSUE_TITLE_MAX_CHARS,
  type BugBusterEvent,
  type ExemplarRef,
  type FoldDelta,
  type Issue,
} from "@bugbusterhq/types";

const DUPLICATE_KEY_ERROR_CODE = 11000;

/**
 * The internal storage shape differs from the public `Issue` wire shape (@bugbusterhq/types) by
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
  /** From the first stored example event; see `Issue.title`. Older issues get it on first read. */
  title?: IssueTitle;
  /** See `Issue.services`. Absent on issues stored before services were; filled on first read. */
  services?: string[];
  /** See `Issue.environments`. Filled on first read for issues stored before environments were. */
  environments?: string[];
  /**
   * When the issue started waiting for an email alert; removed once that alert has been dealt with
   * (sent, or skipped by the org's settings). Set when the issue is created, in the same write, so
   * no new issue can slip through; and again the first time it appears in another environment or
   * service, so an error first seen in staging still alerts when it reaches production.
   */
  alertPendingAt?: string;
}

export interface IssueTitle {
  type: string;
  message: string;
}

/** The title an example event gives its issue. */
export function titleFromEvent(
  event: Pick<BugBusterEvent, "type"> & { error?: { type: string; message: string } },
): IssueTitle {
  return {
    type: event.error?.type ?? event.type,
    message: (event.error?.message ?? "").slice(0, ISSUE_TITLE_MAX_CHARS),
  };
}

/**
 * Gives an issue its title if it has none yet. The first example event names the issue, and
 * later ones never rename it, so the list stays stable while an error keeps happening.
 */
export async function setIssueTitleIfMissing(
  db: Db,
  fingerprint: string,
  title: IssueTitle,
): Promise<void> {
  await issuesCollection(db).updateOne(
    { fingerprint, title: { $exists: false } },
    { $set: { title } },
  );
}

/**
 * Fills in what issues stored by an older backend lack, from their example events: the title
 * (from the first example) and the services (from all of them). One query for the whole page,
 * written back so it happens once per issue. Best-effort: a failure here only means those issues
 * are listed without a title or services this time.
 */
async function fillFromExamples(db: Db, docs: IssueDocument[]): Promise<void> {
  const needing = docs.filter(
    (d) => (!d.title || !d.services || !d.environments) && (d.exemplarRefs ?? []).length > 0,
  );
  if (needing.length === 0) return;
  try {
    const ids = needing.flatMap((d) => d.exemplarRefs.map((r) => r.eventId));
    const events = await db
      .collection<BugBusterEvent>("events")
      .find(
        { eventId: { $in: ids } },
        {
          projection: {
            _id: 0,
            eventId: 1,
            type: 1,
            "error.type": 1,
            "error.message": 1,
            "service.name": 1,
            "service.environment": 1,
          },
        },
      )
      .toArray();
    const byId = new Map(events.map((e) => [e.eventId, e]));
    const writes = [];
    for (const doc of needing) {
      const first = byId.get(doc.exemplarRefs[0]!.eventId);
      if (!doc.title && first) {
        doc.title = titleFromEvent(first);
        writes.push({
          updateOne: {
            filter: { fingerprint: doc.fingerprint, title: { $exists: false } },
            update: { $set: { title: doc.title } },
          },
        });
      }
      for (const field of ["services", "environments"] as const) {
        if (doc[field]) continue;
        const key = field === "services" ? "name" : "environment";
        const values = doc.exemplarRefs
          .map((r) => byId.get(r.eventId)?.service?.[key])
          .filter((v): v is string => !!v);
        doc[field] = [...new Set(values)];
        writes.push({
          updateOne: {
            filter: { fingerprint: doc.fingerprint },
            update: { $addToSet: { [field]: { $each: doc[field] } } },
          },
        });
      }
    }
    if (writes.length > 0) await issuesCollection(db).bulkWrite(writes, { ordered: false });
  } catch {
    // listed without them this time; the next read tries again
  }
}

const MAX_DURATION_SAMPLES = 1000;
const TOP_K = 20;

function issuesCollection(db: Db): Collection<IssueDocument> {
  return db.collection<IssueDocument>("issues");
}

export async function ensureIssuesIndexes(db: Db): Promise<void> {
  await issuesCollection(db).createIndex({ fingerprint: 1 }, { unique: true });
  await issuesCollection(db).createIndex({ lastSeen: -1, fingerprint: -1 });
  // The Issues view filtered to one service, in the same newest-first order.
  await issuesCollection(db).createIndex({ services: 1, lastSeen: -1, fingerprint: -1 });
  // Sparse: only issues whose alert has not been dealt with yet are in it.
  await issuesCollection(db).createIndex({ alertPendingAt: 1 }, { sparse: true });
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
/**
 * What a fold did to its issue, for email alerts: `created` when the error is new, `newPlace` when
 * an existing issue appeared in an environment or service it had not been seen in before.
 */
export interface FoldOutcome {
  created: boolean;
  newPlace: boolean;
}

export async function upsertFoldDelta(
  db: Db,
  delta: FoldDelta,
  context: { environments?: readonly string[] } = {},
): Promise<FoldOutcome> {
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
    alertPendingAt: now,
  };
  if (endpointEntries.length === 0) {
    setOnInsert.endpointCounts = {};
  }

  const update = {
    $inc: inc,
    $addToSet: {
      userIdSet: { $each: delta.userIds },
      releases: { $each: delta.release ? [delta.release] : [] },
      services: { $each: delta.service ? [delta.service] : [] },
      environments: { $each: [...(context.environments ?? [])] },
    },
    $push: {
      durationSamplesMs: { $each: delta.durationSamplesMs, $slice: -MAX_DURATION_SAMPLES },
    },
    $set: { lastSeen: now },
    $setOnInsert: setOnInsert,
  };

  // The document as it was before this fold (null when this fold created it), to tell whether the
  // fold brought the issue somewhere new. Only lists that already existed count: an issue from
  // before environments were recorded gains its first ones without being "new" there.
  const outcome = async (
    before: Pick<IssueDocument, "services" | "environments"> | null,
  ): Promise<FoldOutcome> => {
    if (before === null) return { created: true, newPlace: false };
    const seen = (list: string[] | undefined, value: string) =>
      !Array.isArray(list) || list.includes(value);
    const newPlace =
      (delta.service !== undefined && !seen(before.services, delta.service)) ||
      (context.environments ?? []).some((env) => !seen(before.environments, env));
    if (newPlace) {
      await issuesCollection(db).updateOne(
        { fingerprint: delta.fingerprint },
        { $set: { alertPendingAt: now } },
      );
    }
    return { created: false, newPlace };
  };
  const options = {
    upsert: true,
    returnDocument: "before" as const,
    projection: { _id: 0, services: 1, environments: 1 },
  };

  try {
    return await outcome(
      await issuesCollection(db).findOneAndUpdate(
        { fingerprint: delta.fingerprint },
        update,
        options,
      ),
    );
  } catch (err) {
    // Two concurrent upserts can both see "no matching document" and both attempt an insert;
    // the unique index on `fingerprint` lets exactly one succeed and the other gets a duplicate
    // key error. By the time that happens, the document now exists, so retrying as a plain
    // (non-racing) update applies the same $inc/$addToSet/$push correctly — without this retry,
    // that occurrence's count is silently lost under concurrent writers.
    if (err instanceof MongoServerError && err.code === DUPLICATE_KEY_ERROR_CODE) {
      // The other writer created it, so this one did not.
      return await outcome(
        await issuesCollection(db).findOneAndUpdate(
          { fingerprint: delta.fingerprint },
          update,
          options,
        ),
      );
    }
    throw err;
  }
}

/**
 * Adds one exemplar reference, enforcing the ≤6-per-issue cap (ingest-pipeline.md §4.1), and says
 * whether the issue keeps this exemplar: true when it was just added or was already recorded (a
 * retried send), false when the issue is at its cap or does not exist. The caller stores the event
 * itself only when this returns true, so an exemplar nobody will ever show is never written.
 *
 * One conditional update, not a read then a write: two concurrent sends could otherwise both see
 * five references and both push, and the cap would not hold.
 */
export async function addExemplarRef(
  db: Db,
  fingerprint: string,
  ref: ExemplarRef,
  maxExemplars = 6,
): Promise<boolean> {
  const result = await issuesCollection(db).updateOne(
    {
      fingerprint,
      "exemplarRefs.eventId": { $ne: ref.eventId },
      [`exemplarRefs.${maxExemplars - 1}`]: { $exists: false }, // fewer than maxExemplars so far
    },
    { $push: { exemplarRefs: ref } },
  );
  if (result.modifiedCount === 1) return true;
  const alreadyRecorded = await issuesCollection(db).countDocuments(
    { fingerprint, "exemplarRefs.eventId": ref.eventId },
    { limit: 1 },
  );
  return alreadyRecorded > 0;
}

/** Undoes addExemplarRef when the event it points at could not be stored. */
export async function removeExemplarRef(
  db: Db,
  fingerprint: string,
  eventId: string,
): Promise<void> {
  await issuesCollection(db).updateOne({ fingerprint }, { $pull: { exemplarRefs: { eventId } } });
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
    ...(doc.title ? { title: doc.title } : {}),
    services: doc.services ?? [],
    environments: doc.environments ?? [],
  };
}

export interface IssuesCursor {
  lastSeen: string;
  fingerprint: string;
}

export interface IssuesPage {
  issues: Issue[];
  nextCursor?: string;
}

// Opaque to callers by design (docs/api.md): base64 is just an encoding, not an attempt at
// tamper-resistance — a forged cursor only ever resends a differently-scoped page of the same
// caller's own org data, never another org's, since org scoping happens before this is reached.
export function encodeIssuesCursor(cursor: IssuesCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeIssuesCursor(raw: string): IssuesCursor | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed?.lastSeen === "string" && typeof parsed?.fingerprint === "string") {
      return { lastSeen: parsed.lastSeen, fingerprint: parsed.fingerprint };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * `lastSeen` alone isn't a stable sort key — two issues can share a timestamp — so the cursor
 * pins `(lastSeen, fingerprint)` together and pages strictly "further down that same order,"
 * rather than risking a skipped or repeated row across pages at equal timestamps.
 */
export async function listIssues(
  db: Db,
  opts: { limit?: number; cursor?: IssuesCursor; service?: string } = {},
): Promise<IssuesPage> {
  const limit = opts.limit ?? 50;
  const filter: Filter<IssueDocument> = opts.service ? { services: opts.service } : {};
  if (opts.cursor) {
    filter.$or = [
      { lastSeen: { $lt: opts.cursor.lastSeen } },
      { lastSeen: opts.cursor.lastSeen, fingerprint: { $lt: opts.cursor.fingerprint } },
    ];
  }

  const docs = await issuesCollection(db)
    .find(filter)
    .sort({ lastSeen: -1, fingerprint: -1 })
    .limit(limit + 1)
    .toArray();

  const hasMore = docs.length > limit;
  const page = hasMore ? docs.slice(0, limit) : docs;
  await fillFromExamples(db, page);
  const last = page[page.length - 1];
  return {
    issues: page.map(toPublicIssue),
    nextCursor:
      hasMore && last
        ? encodeIssuesCursor({ lastSeen: last.lastSeen, fingerprint: last.fingerprint })
        : undefined,
  };
}

/** Issues waiting for their email alert, oldest first. */
export async function listAlertPending(db: Db, limit: number): Promise<IssueDocument[]> {
  return issuesCollection(db)
    .find({ alertPendingAt: { $exists: true } })
    .sort({ alertPendingAt: 1 })
    .limit(limit)
    .toArray();
}

/** Marks these issues' alerts as dealt with. */
export async function clearAlertPending(db: Db, fingerprints: readonly string[]): Promise<void> {
  if (fingerprints.length === 0) return;
  await issuesCollection(db).updateMany(
    { fingerprint: { $in: [...fingerprints] } },
    { $unset: { alertPendingAt: "" } },
  );
}

/** Clears every pending alert mark, for an org whose alerts are off. */
export async function clearAllAlertPending(db: Db): Promise<void> {
  await issuesCollection(db).updateMany(
    { alertPendingAt: { $exists: true } },
    { $unset: { alertPendingAt: "" } },
  );
}

/**
 * Whether an older issue is the same error as this one: same service, same error type and message,
 * thrown from the same place (function, file and line of its first example). That is what an SDK
 * upgrade that changes fingerprints looks like (0.3 added the service to them): the error isn't
 * new, only its fingerprint is, so it should not be alerted as new. The same message from another
 * place in the code is a different bug, and does alert.
 */
export async function hasEarlierTwin(db: Db, issue: IssueDocument): Promise<boolean> {
  const firstRef = issue.exemplarRefs?.[0];
  if (!issue.title || !issue.services?.length || !firstRef) return false;
  const candidates = await issuesCollection(db)
    .find(
      {
        fingerprint: { $ne: issue.fingerprint },
        "title.type": issue.title.type,
        "title.message": issue.title.message,
        services: { $in: issue.services },
        firstSeen: { $lt: issue.firstSeen },
      },
      { projection: { _id: 0, exemplarRefs: 1 } },
    )
    .limit(20)
    .toArray();
  const twinRefs = candidates.flatMap((c) =>
    c.exemplarRefs?.[0] ? [c.exemplarRefs[0].eventId] : [],
  );
  if (twinRefs.length === 0) return false;
  const events = await db
    .collection<BugBusterEvent>("events")
    .find(
      { eventId: { $in: [firstRef.eventId, ...twinRefs] } },
      { projection: { _id: 0, eventId: 1, source: 1 } },
    )
    .toArray();
  const where = (e: BugBusterEvent | undefined) =>
    e?.source ? `${e.source.function}@${e.source.file}:${e.source.line}` : undefined;
  const mine = where(events.find((e) => e.eventId === firstRef.eventId));
  if (mine === undefined) return false;
  return events.some((e) => e.eventId !== firstRef.eventId && where(e) === mine);
}

/** Every service any issue has been seen in, for the Issues view's filter. */
export async function listIssueServices(db: Db): Promise<string[]> {
  const names = await issuesCollection(db).distinct("services", {}, { maxTimeMS: 5000 });
  return (names as string[]).filter(Boolean).sort();
}

export async function getIssue(db: Db, fingerprint: string): Promise<Issue | undefined> {
  const doc = await issuesCollection(db).findOne({ fingerprint });
  if (!doc) return undefined;
  await fillFromExamples(db, [doc]);
  return toPublicIssue(doc);
}
