import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { Collection, ObjectId, type Db } from "mongodb";
import {
  encodeEnvelope,
  type BugBusterEvent,
  type Envelope,
  type FoldDelta,
  type LogEntry,
} from "@bugbusterhq/types";
import { ControlDb } from "../../src/db/control.js";
import { buildServer } from "../../src/build-server.js";
import { deleteUnreferencedEvents, countUnreferencedEvents } from "../../src/db/maintenance.js";

const ADMIN = "storage-test-admin-token-0123456789-abcdef";

let mongo: MongoMemoryServer;
let controlDb: ControlDb;
let app: FastifyInstance;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  controlDb = new ControlDb(mongo.getUri());
  await controlDb.connect();
  app = buildServer(
    {
      port: 0,
      controlDbUri: mongo.getUri(),
      ingestMaxBodyBytes: 1024 * 1024,
      logRetentionDays: 7,
      adminToken: ADMIN,
    },
    controlDb,
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await controlDb.close();
  await mongo.stop();
});

const db = (name: string): Db => controlDb.getClient().db(name);

async function createOrg(orgId: string, extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/admin/orgs",
    headers: { authorization: `Bearer ${ADMIN}` },
    payload: { orgId, name: orgId, ...extra },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { apiKey: string; dbName: string; logRetentionDays?: number };
}

async function ingest(apiKey: string, items: Envelope["items"]) {
  const res = await app.inject({
    method: "POST",
    url: "/ingest",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/x-ndjson" },
    payload: encodeEnvelope({ sentAt: new Date().toISOString(), sdkVersion: "test", items }),
  });
  expect(res.statusCode).toBe(202);
}

const fold = (fingerprint: string, count = 1): Envelope["items"][number] => ({
  type: "fold",
  priority: 9,
  payload: {
    fingerprint,
    windowStart: new Date(0).toISOString(),
    windowEnd: new Date().toISOString(),
    count,
    userIds: [],
    endpointCounts: {},
    durationSamplesMs: [],
    exemplars: [],
  } satisfies FoldDelta,
});

const exemplar = (fingerprint: string, eventId: string): Envelope["items"][number] => ({
  type: "exemplar",
  priority: 9,
  payload: {
    eventId,
    fingerprint,
    exemplarRole: "last",
    timestamp: new Date().toISOString(),
    type: "exception",
    trace: { traceId: "t-" + eventId, spanId: "s" },
    service: { name: "svc", version: "1", environment: "test" },
    source: { function: "f", file: "a.ts", line: 1 },
    error: { type: "Error", message: "boom", stacktrace: "Error: boom" },
  } satisfies BugBusterEvent,
});

const logItem = (i: number): Envelope["items"][number] => ({
  type: "log",
  priority: 1,
  payload: {
    logId: `storage-log-${i}-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    level: "info",
    message: `GET /api/products/${i} 200 18ms`,
    service: { name: "svc", version: "1", environment: "test" },
  } satisfies LogEntry,
});

describe("exemplars are only stored when their issue keeps them", () => {
  it("stores at most six per issue, however many the SDK sends", async () => {
    const org = await createOrg("cap");
    await ingest(org.apiKey, [
      fold("fp-cap"),
      ...Array.from({ length: 9 }, (_, i) => exemplar("fp-cap", `ev-${i}`)),
    ]);
    const issue = await db(org.dbName).collection("issues").findOne({ fingerprint: "fp-cap" });
    expect(issue?.exemplarRefs).toHaveLength(6);
    expect(await db(org.dbName).collection("events").countDocuments()).toBe(6);
  });

  it("keeps a re-sent exemplar exactly once, and stores none for an issue that doesn't exist", async () => {
    const org = await createOrg("resend");
    await ingest(org.apiKey, [fold("fp-r"), exemplar("fp-r", "ev-a")]);
    await ingest(org.apiKey, [fold("fp-r"), exemplar("fp-r", "ev-a")]); // a retried batch
    await ingest(org.apiKey, [exemplar("fp-nobody", "ev-orphan")]);
    const events = db(org.dbName).collection("events");
    expect(await events.countDocuments({ eventId: "ev-a" })).toBe(1);
    expect(await events.countDocuments({ eventId: "ev-orphan" })).toBe(0);
    const issue = await db(org.dbName).collection("issues").findOne({ fingerprint: "fp-r" });
    expect(issue?.exemplarRefs).toHaveLength(1);
    expect(issue?.count).toBe(2);
  });

  it("a failure storing an exemplar never fails the request (no retry, so folds are never counted twice)", async () => {
    const org = await createOrg("failsafe");
    const real = Collection.prototype.updateOne;
    const spy = vi.spyOn(Collection.prototype, "updateOne").mockImplementation(function (
      this: Collection,
      ...args: Parameters<Collection["updateOne"]>
    ) {
      if (this.collectionName === "events") return Promise.reject(new Error("disk full"));
      return real.apply(this, args);
    } as Collection["updateOne"]);
    try {
      await ingest(org.apiKey, [fold("fp-f", 3), exemplar("fp-f", "ev-f")]); // asserts 202
    } finally {
      spy.mockRestore();
    }
    const issue = await db(org.dbName).collection("issues").findOne({ fingerprint: "fp-f" });
    expect(issue?.count).toBe(3);
    expect(issue?.exemplarRefs).toHaveLength(0); // the claimed reference was released
  });
});

describe("cleaning up unreferenced events", () => {
  it("deletes only orphans older than the safety window, and is safe to repeat", async () => {
    const org = await createOrg("cleanup");
    await ingest(org.apiKey, [fold("fp-c"), exemplar("fp-c", "ev-kept")]);
    const events = db(org.dbName).collection("events");
    const old = ObjectId.createFromTime(Math.floor(Date.now() / 1000) - 3600);
    await events.insertMany([
      { _id: old, eventId: "orphan-old", fingerprint: "fp-c" },
      { eventId: "orphan-new", fingerprint: "fp-c" }, // written just now: could be mid-ingest
    ]);
    expect(await countUnreferencedEvents(db(org.dbName))).toBe(1);
    expect(await deleteUnreferencedEvents(db(org.dbName))).toBe(1);
    expect(await deleteUnreferencedEvents(db(org.dbName))).toBe(0);
    const left = (await events.find({}, { projection: { eventId: 1 } }).toArray())
      .map((e) => e.eventId)
      .sort();
    expect(left).toEqual(["ev-kept", "orphan-new"]);
  });
});

describe("logs collections are created with zstd compression", () => {
  it("a new org's logs collection uses zstd", async () => {
    const org = await createOrg("zstd");
    await ingest(org.apiKey, [logItem(1)]);
    const [stats] = await db(org.dbName)
      .collection("logs")
      .aggregate<{ storageStats: { wiredTiger?: { creationString?: string } } }>([
        { $collStats: { storageStats: {} } },
      ])
      .toArray();
    expect(stats?.storageStats.wiredTiger?.creationString).toContain("block_compressor=zstd");
  });
});

describe("per-org log retention", () => {
  const ttl = async (dbName: string) =>
    (await db(dbName).collection("logs").listIndexes().toArray()).find(
      (i) => i.name === "receivedAt_ttl",
    )?.expireAfterSeconds as number | undefined;
  const patch = (orgId: string, payload: unknown, token = ADMIN) =>
    app.inject({
      method: "PATCH",
      url: `/admin/orgs/${orgId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as Record<string, unknown>,
    });

  it("an org created with its own retention gets it; others keep the backend default", async () => {
    const custom = await createOrg("ret-custom", { logRetentionDays: 30 });
    const plain = await createOrg("ret-plain");
    expect(custom.logRetentionDays).toBe(30);
    await ingest(custom.apiKey, [logItem(1)]);
    await ingest(plain.apiKey, [logItem(2)]);
    expect(await ttl(custom.dbName)).toBe(30 * 86400);
    expect(await ttl(plain.dbName)).toBe(7 * 86400);
  });

  it("PATCH applies a change at once, null returns to the default, 0 keeps forever", async () => {
    const org = await createOrg("ret-change");
    await ingest(org.apiKey, [logItem(1)]);
    const r1 = await patch("ret-change", { logRetentionDays: 2 });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ logRetentionDays: 2, retentionOverridden: true });
    expect(await ttl(org.dbName)).toBe(2 * 86400);

    const r2 = await patch("ret-change", { logRetentionDays: null });
    expect(r2.json()).toMatchObject({ logRetentionDays: 7, retentionOverridden: false });
    expect(await ttl(org.dbName)).toBe(7 * 86400);

    await patch("ret-change", { logRetentionDays: 0 });
    expect(await ttl(org.dbName)).toBeUndefined(); // no TTL index: kept forever

    // This process's auth cache follows the change: the next request does not restore the old TTL.
    await patch("ret-change", { logRetentionDays: 3 });
    await ingest(org.apiKey, [logItem(2)]);
    expect(await ttl(org.dbName)).toBe(3 * 86400);
  });

  it("validates input and refuses without the admin token", async () => {
    await createOrg("ret-validate");
    for (const bad of [
      {},
      { logRetentionDays: -1 },
      { logRetentionDays: 1.5 },
      { logRetentionDays: "7" },
      { logRetentionDays: 4000 },
    ]) {
      expect((await patch("ret-validate", bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await patch("nobody-here", { logRetentionDays: 3 })).statusCode).toBe(404);
    expect((await patch("ret-validate", { logRetentionDays: 3 }, "wrong")).statusCode).toBe(401);
    const badCreate = await app.inject({
      method: "POST",
      url: "/admin/orgs",
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { orgId: "ret-bad", name: "x", logRetentionDays: null },
    });
    expect(badCreate.statusCode).toBe(400);
  });
});

describe("GET /admin/storage", () => {
  it("reports sizes, compression, logs per day and unreferenced events, per org", async () => {
    const org = await createOrg("report", { logRetentionDays: 14 });
    await ingest(org.apiKey, [
      fold("fp-rep"),
      exemplar("fp-rep", "ev-rep"),
      ...Array.from({ length: 20 }, (_, i) => logItem(i)),
    ]);
    await db(org.dbName)
      .collection("events")
      .insertOne({
        _id: ObjectId.createFromTime(Math.floor(Date.now() / 1000) - 3600),
        eventId: "old-orphan",
      });

    const res = await app.inject({
      method: "GET",
      url: "/admin/storage?orgId=report",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.defaultLogRetentionDays).toBe(7);
    expect(body.orgs).toHaveLength(1);
    const r = body.orgs[0];
    expect(r).toMatchObject({
      orgId: "report",
      logRetentionDays: 14,
      retentionOverridden: true,
      unreferencedEvents: 1,
    });
    expect(r.collections.logs.documents).toBe(20);
    expect(r.collections.logs.compression).toBe("zstd");
    expect(r.collections.logs.indexBytes).toBeGreaterThan(0);
    expect(r.collections.events.documents).toBe(2);
    expect(r.logsPerDay).toHaveLength(7);
    expect(r.logsPerDay.at(-1).lines).toBe(20);
    expect(r.logsPerDay.at(-1).estimatedBytes).toBeGreaterThan(0);
    expect(r.totalBytes).toBeGreaterThan(0);
    expect(body.totalBytes).toBe(r.totalBytes);
  });

  it("lists every org, does not create collections for idle ones, and needs the admin token", async () => {
    await controlDb.createOrg({
      orgId: "idle",
      name: "Idle",
      dbName: "bugbuster_org_idle_never_used",
      apiKey: "idle-key",
    });
    const all = await app.inject({
      method: "GET",
      url: "/admin/storage",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    const idle = all.json().orgs.find((o: { orgId: string }) => o.orgId === "idle");
    expect(idle).toMatchObject({ totalBytes: 0, logsPerDay: [], unreferencedEvents: 0 });
    expect(await db("bugbuster_org_idle_never_used").listCollections().toArray()).toHaveLength(0);

    expect((await app.inject({ method: "GET", url: "/admin/storage" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/admin/storage?orgId=missing",
          headers: { authorization: `Bearer ${ADMIN}` },
        })
      ).statusCode,
    ).toBe(404);
  });
});
