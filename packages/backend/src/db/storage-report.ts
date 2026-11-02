import type { Db } from "mongodb";
import { countUnreferencedEvents } from "./maintenance.js";

/**
 * What each org's data costs in MongoDB, so storage decisions (retention, quotas, archiving) are
 * made from measurements instead of guesses. Read-only: it never creates a collection or an index,
 * so reporting on an org that has never sent anything leaves its database untouched.
 */

const COLLECTIONS = ["logs", "issues", "events"] as const;
const DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface CollectionStorage {
  documents: number;
  /** Uncompressed size of the documents. */
  dataBytes: number;
  /** Bytes on disk for the documents, after compression. */
  storageBytes: number;
  /** Bytes on disk for the collection's indexes. */
  indexBytes: number;
  /** WiredTiger block compressor (zstd, snappy, zlib, none), when the server reports it. */
  compression?: string;
}

export interface OrgStorage {
  orgId: string;
  name: string;
  dbName: string;
  logRetentionDays: number;
  /** True when this org overrides the backend's default retention. */
  retentionOverridden: boolean;
  collections: Record<(typeof COLLECTIONS)[number], CollectionStorage>;
  /** storageBytes + indexBytes over every collection above. */
  totalBytes: number;
  /** Log lines received per UTC day over the last 7 days, oldest first, with their estimated size. */
  logsPerDay: { date: string; lines: number; estimatedBytes: number }[];
  /** Stored exemplars no issue references (deleted by `pnpm cleanup-events`). */
  unreferencedEvents: number;
}

const EMPTY: CollectionStorage = { documents: 0, dataBytes: 0, storageBytes: 0, indexBytes: 0 };

async function collectionStorage(db: Db, name: string): Promise<CollectionStorage> {
  const exists = (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;
  if (!exists) return { ...EMPTY };
  const [stats] = await db
    .collection(name)
    .aggregate<{ storageStats: Record<string, unknown> }>([{ $collStats: { storageStats: {} } }])
    .toArray();
  const s = stats?.storageStats ?? {};
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const creation = (s.wiredTiger as { creationString?: string } | undefined)?.creationString;
  const compression = creation?.match(/block_compressor=(\w*)/)?.[1];
  return {
    documents: num(s.count),
    dataBytes: num(s.size),
    storageBytes: num(s.storageSize),
    indexBytes: num(s.totalIndexSize),
    ...(compression !== undefined ? { compression: compression || "none" } : {}),
  };
}

/** Counts on `receivedAt`, the field the retention (TTL) index is built on, so it is an index scan. */
async function logsPerDay(
  db: Db,
  avgBytesPerLine: number,
  now: Date,
): Promise<OrgStorage["logsPerDay"]> {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = new Date(todayUtc - (DAYS - 1) * MS_PER_DAY);
  const rows = await db
    .collection("logs")
    .aggregate<{ _id: string; lines: number }>([
      { $match: { receivedAt: { $gte: start } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$receivedAt", timezone: "UTC" } },
          lines: { $sum: 1 },
        },
      },
    ])
    .toArray();
  const byDay = new Map(rows.map((r) => [r._id, r.lines]));
  return Array.from({ length: DAYS }, (_, i) => {
    const date = new Date(start.getTime() + i * MS_PER_DAY).toISOString().slice(0, 10);
    const lines = byDay.get(date) ?? 0;
    return { date, lines, estimatedBytes: Math.round(lines * avgBytesPerLine) };
  });
}

export async function orgStorageReport(
  db: Db,
  org: { orgId: string; name: string; dbName: string; logRetentionDays?: number },
  defaultRetentionDays: number,
  now = new Date(),
): Promise<OrgStorage> {
  const entries = await Promise.all(
    COLLECTIONS.map(async (name) => [name, await collectionStorage(db, name)] as const),
  );
  const collections = Object.fromEntries(entries) as OrgStorage["collections"];
  const logs = collections.logs;
  const avg = logs.documents > 0 ? logs.dataBytes / logs.documents : 0;
  const hasEvents = collections.events.documents > 0;
  return {
    orgId: org.orgId,
    name: org.name,
    dbName: org.dbName,
    logRetentionDays: org.logRetentionDays ?? defaultRetentionDays,
    retentionOverridden: org.logRetentionDays !== undefined,
    collections,
    totalBytes: entries.reduce((sum, [, c]) => sum + c.storageBytes + c.indexBytes, 0),
    logsPerDay: logs.documents > 0 ? await logsPerDay(db, avg, now) : [],
    unreferencedEvents: hasEvents ? await countUnreferencedEvents(db, { now }) : 0,
  };
}
