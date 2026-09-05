import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Db } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BugBusterEvent, FoldDelta } from "@bugbuster/types";
import {
  addExemplarRef,
  ensureIssuesIndexes,
  getIssue,
  upsertFoldDelta,
} from "../../src/db/collections/issues.js";
import { insertExemplar } from "../../src/db/collections/events.js";

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Db;

function fold(overrides: Partial<FoldDelta> = {}): FoldDelta {
  return {
    fingerprint: "fp_test",
    windowStart: new Date(0).toISOString(),
    windowEnd: new Date().toISOString(),
    count: 1,
    userIds: [],
    endpointCounts: {},
    durationSamplesMs: [],
    exemplars: [],
    ...overrides,
  };
}

function exemplar(eventId: string, fingerprint = "fp_test"): BugBusterEvent {
  return {
    eventId,
    fingerprint,
    exemplarRole: "first",
    timestamp: new Date().toISOString(),
    type: "exception",
    trace: { traceId: "t", spanId: "s" },
    service: { name: "svc", version: "1.0.0", environment: "production" },
    source: { function: "f", file: "f.ts", line: 1 },
    error: { type: "Err", message: "boom", stacktrace: "Err: boom" },
  };
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = new MongoClient(mongo.getUri());
  await client.connect();
});

beforeEach(async () => {
  db = client.db(`test_${Math.random().toString(36).slice(2)}`);
  // Production code creates this via TenantDbResolver before any write touches the collection
  // (db/tenant.ts) — done explicitly here since this test talks to the collection directly. The
  // unique index is not an optimization: without it, concurrent upserts race to create duplicate
  // documents instead of safely colliding into one, which is exactly the bug this suite exists to
  // catch (and did, the first time this test ran without it).
  await ensureIssuesIndexes(db);
});

afterAll(async () => {
  await client.close();
  await mongo.stop();
});

describe("upsertFoldDelta — atomic fold-merge upsert", () => {
  it("a freshly created issue defaults adjustedCount to 1.0", async () => {
    await upsertFoldDelta(db, fold());
    const issue = await getIssue(db, "fp_test");
    expect(issue?.adjustedCount).toBe(1.0);
  });

  it("increments count atomically under N concurrent writers with no lost updates", async () => {
    const concurrentWriters = 50;
    await Promise.all(
      Array.from({ length: concurrentWriters }, () => upsertFoldDelta(db, fold({ count: 1 }))),
    );
    const issue = await getIssue(db, "fp_test");
    expect(issue?.count).toBe(concurrentWriters); // every increment landed — none lost to a race
  });

  it("computes usersAffected as the exact deduplicated union across multiple upserts", async () => {
    await upsertFoldDelta(db, fold({ userIds: ["u1", "u2"] }));
    await upsertFoldDelta(db, fold({ userIds: ["u2", "u3"] }));
    const issue = await getIssue(db, "fp_test");
    expect(issue?.usersAffected).toBe(3);
  });
});

describe("addExemplarRef — the ≤6-per-issue exemplar cap", () => {
  it("stores exemplars up to the cap and rejects the 7th", async () => {
    await upsertFoldDelta(db, fold());
    for (let i = 0; i < 6; i++) {
      await insertExemplar(db, exemplar(`evt_${i}`));
      await addExemplarRef(db, "fp_test", { eventId: `evt_${i}`, role: "first" });
    }
    // the 7th
    await insertExemplar(db, exemplar("evt_overflow"));
    await addExemplarRef(db, "fp_test", { eventId: "evt_overflow", role: "first" });

    const issue = await getIssue(db, "fp_test");
    expect(issue?.exemplarRefs).toHaveLength(6);
    expect(issue?.exemplarRefs.map((r) => r.eventId)).not.toContain("evt_overflow");
  });

  it("is idempotent — recording the same exemplar id twice does not double-count toward the cap", async () => {
    await upsertFoldDelta(db, fold());
    await addExemplarRef(db, "fp_test", { eventId: "evt_dup", role: "first" });
    await addExemplarRef(db, "fp_test", { eventId: "evt_dup", role: "first" });
    const issue = await getIssue(db, "fp_test");
    expect(issue?.exemplarRefs).toHaveLength(1);
  });
});
