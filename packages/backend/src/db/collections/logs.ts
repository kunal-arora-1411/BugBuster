import { MongoBulkWriteError, MongoServerError, type Collection, type Db } from "mongodb";
import {
  MAX_LOG_FIELDS_BYTES,
  MAX_LOG_MESSAGE_CHARS,
  type LogEntry,
  type LogLevel,
} from "@bugbusterhq/types";

/**
 * The `logs` collection — one document per application log line, never folded (the opposite of
 * `issues`; see packages/types/src/log.ts for why).
 *
 * Two timestamps on purpose:
 *  - `timestamp` is WHEN IT HAPPENED (the application's clock). It is what users filter and sort
 *    by, so it is what the query indexes are built on.
 *  - `receivedAt` is when this backend stored it (our clock). It is what the TTL index expires on.
 *    Expiring on `timestamp` would let a client with a wrong clock write a log dated in the far
 *    future that is never deleted, or one dated long ago that is deleted instantly. Our own clock
 *    is the only one retention can safely trust.
 *
 * Both are real BSON Dates (not ISO strings like the other collections) — TTL indexes require it,
 * and range queries on Dates are what the indexes are best at.
 */
export interface LogDocument {
  logId: string;
  timestamp: Date;
  receivedAt: Date;
  level: LogLevel;
  message: string;
  fields?: Record<string, unknown>;
  trace?: { traceId: string; spanId?: string };
  service: { name: string; version: string; environment: string };
}

const DUPLICATE_KEY_ERROR_CODE = 11000;
const TTL_INDEX_NAME = "receivedAt_ttl";
const SECONDS_PER_DAY = 24 * 60 * 60;

/** A client clock this far ahead of ours is treated as wrong; the line is stamped with our time. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
/** A query regex is user input going into the database; bound it. */
const MAX_SEARCH_CHARS = 200;
const QUERY_MAX_TIME_MS = 8000;

function logsCollection(db: Db): Collection<LogDocument> {
  return db.collection<LogDocument>("logs");
}

/**
 * Index design — every one exists for a specific query the dashboard makes:
 *  - `logId` (unique): makes a retried ingest batch idempotent — the second insert of the same
 *    line is rejected by the index instead of duplicating it.
 *  - `(timestamp, logId)` desc: the default view and its cursor pagination. `logId` is the
 *    tiebreaker so two lines in the same millisecond page deterministically.
 *  - `(service.name, timestamp, logId)`: "show me only checkout-svc", with the sort served by the
 *    index (equality prefix + the same sort keys) so Mongo never has to sort in memory.
 *  - `(trace.traceId, timestamp, logId)`: "everything this request did" — the jump from an error
 *    to its logs. Partial, so lines with no trace (background jobs) don't bloat it.
 *  - `receivedAt` TTL: retention.
 * There is deliberately no index on `level` or `message`: level filters ride the time range, and
 * substring search is a bounded regex scan over the (time-limited) result set — a text index
 * would only match whole stemmed words, which is not what anyone searching logs for "o_1042" or
 * "ECONNRESET 10.0.3" wants.
 */
export async function ensureLogsIndexes(db: Db, opts: { retentionDays: number }): Promise<void> {
  const logs = logsCollection(db);
  await Promise.all([
    logs.createIndex({ logId: 1 }, { unique: true }),
    logs.createIndex({ timestamp: -1, logId: -1 }),
    logs.createIndex({ "service.name": 1, timestamp: -1, logId: -1 }),
    logs.createIndex(
      { "trace.traceId": 1, timestamp: -1, logId: -1 },
      { partialFilterExpression: { "trace.traceId": { $exists: true } } },
    ),
  ]);
  await ensureRetentionIndex(db, opts.retentionDays);
}

async function ensureRetentionIndex(db: Db, retentionDays: number): Promise<void> {
  const logs = logsCollection(db);
  const existing = (await logs.listIndexes().toArray()).find((i) => i.name === TTL_INDEX_NAME);

  if (retentionDays <= 0) {
    // 0 = keep forever. If a TTL index exists from an earlier, stricter setting, remove it —
    // otherwise "disabled" would silently keep deleting data.
    if (existing) await logs.dropIndex(TTL_INDEX_NAME);
    return;
  }

  const expireAfterSeconds = retentionDays * SECONDS_PER_DAY;
  if (!existing) {
    await logs.createIndex({ receivedAt: 1 }, { name: TTL_INDEX_NAME, expireAfterSeconds });
    return;
  }
  // Changing the retention setting must take effect on existing data without a manual migration.
  // createIndex would throw on an option conflict; collMod updates the TTL in place.
  if (existing.expireAfterSeconds !== expireAfterSeconds) {
    await db.command({
      collMod: "logs",
      index: { name: TTL_INDEX_NAME, expireAfterSeconds },
    });
  }
}

/** Recursively makes field KEYS storable: no dots, no leading `$`, bounded depth. */
function sanitizeKeys(value: unknown, depth: number): unknown {
  if (depth > 8) return "[Object]";
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => sanitizeKeys(v, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      let k = key.replace(/\./g, "_");
      if (k.startsWith("$")) k = `_${k.slice(1)}`;
      out[k.length > 0 ? k : "_"] = sanitizeKeys(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Turns a (schema-valid) wire LogEntry into a storable document. The SDK already truncates and
 * sanitizes — but this endpoint accepts bytes from the network, so every bound is enforced again
 * here rather than trusted: a custom or malicious sender must not be able to store unbounded
 * messages, a megabyte of fields, or keys MongoDB cannot query.
 */
export function toLogDocument(entry: LogEntry, receivedAt: Date): LogDocument {
  let timestamp = new Date(entry.timestamp);
  if (timestamp.getTime() > receivedAt.getTime() + MAX_CLOCK_SKEW_MS) timestamp = receivedAt;

  let fields: Record<string, unknown> | undefined;
  if (entry.fields !== undefined) {
    const cleaned = sanitizeKeys(entry.fields, 0) as Record<string, unknown>;
    fields =
      Buffer.byteLength(JSON.stringify(cleaned), "utf8") > MAX_LOG_FIELDS_BYTES
        ? { _truncated: true }
        : cleaned;
  }

  return {
    logId: entry.logId,
    timestamp,
    receivedAt,
    level: entry.level,
    message:
      entry.message.length > MAX_LOG_MESSAGE_CHARS
        ? entry.message.slice(0, MAX_LOG_MESSAGE_CHARS)
        : entry.message,
    ...(fields !== undefined ? { fields } : {}),
    ...(entry.trace !== undefined ? { trace: entry.trace } : {}),
    service: entry.service,
  };
}

function isOnlyDuplicateKeyErrors(err: MongoBulkWriteError): boolean {
  const raw = err.writeErrors;
  const errors = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return errors.length > 0 && errors.every((e) => e.code === DUPLICATE_KEY_ERROR_CODE);
}

/**
 * Inserts a batch of log lines. Idempotent: a line whose `logId` already exists (the Agent or SDK
 * retried a batch whose first attempt actually landed) is skipped, not duplicated and not an
 * error. Unordered, so one bad document never blocks the rest of the batch.
 */
export async function insertLogs(
  db: Db,
  entries: readonly LogEntry[],
  receivedAt = new Date(),
): Promise<number> {
  if (entries.length === 0) return 0;
  const docs = entries.map((e) => toLogDocument(e, receivedAt));
  try {
    const result = await logsCollection(db).insertMany(docs, { ordered: false });
    return result.insertedCount;
  } catch (err) {
    if (err instanceof MongoBulkWriteError && isOnlyDuplicateKeyErrors(err)) {
      return err.insertedCount;
    }
    if (err instanceof MongoServerError && err.code === DUPLICATE_KEY_ERROR_CODE) return 0;
    throw err;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Querying                                                                                    */
/* ------------------------------------------------------------------------------------------ */

export interface LogsCursor {
  /** Epoch milliseconds of the last line on the previous page. */
  t: number;
  /** Its logId — the tiebreaker for lines in the same millisecond. */
  id: string;
}

// Opaque by design, same contract as the issues cursor: base64 is an encoding, not tamper
// resistance. A forged cursor can only re-position within the caller's OWN org's logs.
export function encodeLogsCursor(cursor: LogsCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeLogsCursor(raw: string): LogsCursor | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      typeof parsed?.t === "number" &&
      Number.isFinite(parsed.t) &&
      typeof parsed?.id === "string"
    ) {
      return { t: parsed.t, id: parsed.id };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export interface LogQuery {
  /** Exact levels to include. Omitted = all levels. */
  levels?: readonly LogLevel[];
  service?: string;
  environment?: string;
  traceId?: string;
  /** Case-insensitive substring match against the message. */
  search?: string;
  from?: Date;
  to?: Date;
  limit: number;
  cursor?: LogsCursor;
}

export interface LogsPage {
  logs: LogEntry[];
  nextCursor?: string;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toPublicLog(doc: LogDocument): LogEntry {
  return {
    logId: doc.logId,
    timestamp: doc.timestamp.toISOString(),
    level: doc.level,
    message: doc.message,
    ...(doc.fields !== undefined ? { fields: doc.fields } : {}),
    ...(doc.trace !== undefined ? { trace: doc.trace } : {}),
    service: doc.service,
  };
}

/** Newest first. Pages strictly down the (timestamp, logId) order, stable across equal timestamps. */
export async function queryLogs(db: Db, query: LogQuery): Promise<LogsPage> {
  const and: Record<string, unknown>[] = [];

  if (query.levels && query.levels.length > 0) and.push({ level: { $in: [...query.levels] } });
  if (query.service !== undefined) and.push({ "service.name": query.service });
  if (query.environment !== undefined) and.push({ "service.environment": query.environment });
  if (query.traceId !== undefined) and.push({ "trace.traceId": query.traceId });
  if (query.search !== undefined && query.search.length > 0) {
    and.push({
      message: { $regex: escapeRegex(query.search.slice(0, MAX_SEARCH_CHARS)), $options: "i" },
    });
  }
  if (query.from || query.to) {
    and.push({
      timestamp: {
        ...(query.from ? { $gte: query.from } : {}),
        ...(query.to ? { $lte: query.to } : {}),
      },
    });
  }
  if (query.cursor) {
    const at = new Date(query.cursor.t);
    and.push({
      $or: [{ timestamp: { $lt: at } }, { timestamp: at, logId: { $lt: query.cursor.id } }],
    });
  }

  const docs = await logsCollection(db)
    .find(and.length > 0 ? { $and: and } : {}, { projection: { _id: 0, receivedAt: 0 } })
    .sort({ timestamp: -1, logId: -1 })
    .limit(query.limit + 1) // one extra row, only to learn whether another page exists
    .maxTimeMS(QUERY_MAX_TIME_MS) // a pathological search must not be able to pin the database
    .toArray();

  const hasMore = docs.length > query.limit;
  const page = hasMore ? docs.slice(0, query.limit) : docs;
  const last = page[page.length - 1];
  return {
    logs: page.map(toPublicLog),
    nextCursor:
      hasMore && last
        ? encodeLogsCursor({ t: last.timestamp.getTime(), id: last.logId })
        : undefined,
  };
}

/** Distinct services and environments, for the dashboard's filter dropdowns. */
export async function getLogFacets(
  db: Db,
): Promise<{ services: string[]; environments: string[] }> {
  const logs = logsCollection(db);
  const [services, environments] = await Promise.all([
    logs.distinct("service.name", {}, { maxTimeMS: QUERY_MAX_TIME_MS }),
    logs.distinct("service.environment", {}, { maxTimeMS: QUERY_MAX_TIME_MS }),
  ]);
  return {
    services: (services as string[]).sort(),
    environments: (environments as string[]).sort(),
  };
}
