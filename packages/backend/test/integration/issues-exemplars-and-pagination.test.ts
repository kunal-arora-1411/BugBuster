import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { BugBusterEvent } from "@bugbuster/types";
import { ControlDb } from "../../src/db/control.js";
import { buildServer } from "../../src/server.js";
import { TenantDbResolver } from "../../src/db/tenant.js";
import { addExemplarRef, ensureIssuesIndexes, upsertFoldDelta } from "../../src/db/collections/issues.js";
import { ensureEventsIndexes, insertExemplar } from "../../src/db/collections/events.js";
import { _resetOrgCacheForTests } from "../../src/ingest/edge.js";

let mongo: MongoMemoryServer;
let controlDb: ControlDb;
let app: FastifyInstance;
let tenants: TenantDbResolver;

const ORG = {
  orgId: "org_exemplars",
  name: "Exemplars Org",
  dbName: "bugbuster_org_exemplars",
  apiKey: "key-exemplars",
};

function exemplar(eventId: string, fingerprint: string): BugBusterEvent {
  return {
    eventId,
    fingerprint,
    exemplarRole: "first",
    timestamp: new Date().toISOString(),
    type: "exception",
    trace: { traceId: "t", spanId: "s" },
    service: { name: "svc", version: "1.0.0", environment: "production" },
    source: { function: "handler", file: "handler.ts", line: 42 },
    error: { type: "TypeError", message: "boom", stacktrace: "TypeError: boom\n  at handler.ts:42" },
  };
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  controlDb = new ControlDb(mongo.getUri());
  await controlDb.connect();
  await controlDb.createOrg(ORG);
  tenants = new TenantDbResolver(controlDb.getClient());
  app = buildServer({ port: 0, controlDbUri: mongo.getUri(), ingestMaxBodyBytes: 1024 * 1024 }, controlDb);
  await app.ready();
});

beforeEach(() => {
  _resetOrgCacheForTests();
});

afterAll(async () => {
  await app.close();
  await controlDb.close();
  await mongo.stop();
});

describe("GET /issues/:fingerprint/exemplars", () => {
  it("resolves exemplarRefs to full event bodies, in the issue's own ref order", async () => {
    const db = await tenants.forOrgDb(ORG.dbName);
    await upsertFoldDelta(db, {
      fingerprint: "fp_with_exemplars",
      windowStart: new Date(0).toISOString(),
      windowEnd: new Date().toISOString(),
      count: 2,
      userIds: [],
      endpointCounts: {},
      durationSamplesMs: [],
      exemplars: [],
    });
    await insertExemplar(db, exemplar("evt_a", "fp_with_exemplars"));
    await insertExemplar(db, exemplar("evt_b", "fp_with_exemplars"));
    await addExemplarRef(db, "fp_with_exemplars", { eventId: "evt_a", role: "first" });
    await addExemplarRef(db, "fp_with_exemplars", { eventId: "evt_b", role: "slowest" });

    const res = await app.inject({
      method: "GET",
      url: "/issues/fp_with_exemplars/exemplars",
      headers: { authorization: `Bearer ${ORG.apiKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { exemplars: BugBusterEvent[] };
    expect(body.exemplars.map((e) => e.eventId)).toEqual(["evt_a", "evt_b"]);
    expect(body.exemplars[0]?.error?.stacktrace).toContain("handler.ts:42");
  });

  it("404s when the fingerprint doesn't exist in the org's own database", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/issues/fp_does_not_exist/exemplars",
      headers: { authorization: `Bearer ${ORG.apiKey}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns an empty list for an issue with no recorded exemplars", async () => {
    const db = await tenants.forOrgDb(ORG.dbName);
    await upsertFoldDelta(db, {
      fingerprint: "fp_no_exemplars",
      windowStart: new Date(0).toISOString(),
      windowEnd: new Date().toISOString(),
      count: 1,
      userIds: [],
      endpointCounts: {},
      durationSamplesMs: [],
      exemplars: [],
    });

    const res = await app.inject({
      method: "GET",
      url: "/issues/fp_no_exemplars/exemplars",
      headers: { authorization: `Bearer ${ORG.apiKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { exemplars: BugBusterEvent[] };
    expect(body.exemplars).toEqual([]);
  });

  it("rejects a request with no Authorization header", async () => {
    const res = await app.inject({ method: "GET", url: "/issues/fp_with_exemplars/exemplars" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /issues pagination", () => {
  const PAGE_ORG = {
    orgId: "org_pagination",
    name: "Pagination Org",
    dbName: "bugbuster_org_pagination",
    apiKey: "key-pagination",
  };

  beforeAll(async () => {
    await controlDb.createOrg(PAGE_ORG);
    const db = await tenants.forOrgDb(PAGE_ORG.dbName);
    await ensureIssuesIndexes(db);
    await ensureEventsIndexes(db);
    // Seed 5 issues with distinct, controlled lastSeen values (newest first: fp_4 .. fp_0) so
    // page ordering is deterministic rather than depending on write timing.
    for (let i = 0; i < 5; i++) {
      await db.collection("issues").insertOne({
        fingerprint: `fp_${i}`,
        count: 1,
        userIdSet: [],
        endpointCounts: {},
        durationSamplesMs: [],
        releases: [],
        firstSeen: new Date(i * 1000).toISOString(),
        lastSeen: new Date(i * 1000).toISOString(),
        exemplarRefs: [],
        adjustedCount: 1.0,
      });
    }
  });

  it("returns at most `limit` issues per page, most-recently-seen first", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/issues?limit=2",
      headers: { authorization: `Bearer ${PAGE_ORG.apiKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { issues: { fingerprint: string }[]; nextCursor?: string };
    expect(body.issues.map((i) => i.fingerprint)).toEqual(["fp_4", "fp_3"]);
    expect(body.nextCursor).toBeDefined();
  });

  it("walking nextCursor visits every issue exactly once, in order, until nextCursor is absent", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const url = cursor ? `/issues?limit=2&cursor=${encodeURIComponent(cursor)}` : "/issues?limit=2";
      const res = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${PAGE_ORG.apiKey}` },
      });
      const body = JSON.parse(res.body) as { issues: { fingerprint: string }[]; nextCursor?: string };
      seen.push(...body.issues.map((issue) => issue.fingerprint));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(["fp_4", "fp_3", "fp_2", "fp_1", "fp_0"]);
  });

  it("rejects a malformed cursor with 400 rather than silently returning an unfiltered page", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/issues?cursor=not-valid-base64url-json",
      headers: { authorization: `Bearer ${PAGE_ORG.apiKey}` },
    });
    expect(res.statusCode).toBe(400);
  });
});
