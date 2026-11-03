import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { encodeEnvelope, type Envelope } from "@bugbusterhq/types";
import { ControlDb } from "../../src/db/control.js";
import { buildServer } from "../../src/build-server.js";

const ORG = {
  orgId: "services",
  name: "Services",
  dbName: "bugbuster_org_services",
  apiKey: "services-key",
};

let mongo: MongoMemoryServer;
let controlDb: ControlDb;
let app: FastifyInstance;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  controlDb = new ControlDb(mongo.getUri());
  await controlDb.connect();
  await controlDb.createOrg(ORG);
  app = buildServer(
    { port: 0, controlDbUri: mongo.getUri(), ingestMaxBodyBytes: 1024 * 1024 },
    controlDb,
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await controlDb.close();
  await mongo.stop();
});

const db = () => controlDb.getClient().db(ORG.dbName);
const auth = { authorization: `Bearer ${ORG.apiKey}` };

/** One fold and its example event. `foldService: false` is what an SDK before 0.3.0 sends. */
function items(
  fingerprint: string,
  eventId: string,
  service: string,
  foldService = true,
): Envelope["items"] {
  return [
    {
      type: "fold",
      priority: 9,
      payload: {
        fingerprint,
        windowStart: new Date(0).toISOString(),
        windowEnd: new Date().toISOString(),
        count: 1,
        userIds: [],
        endpointCounts: {},
        durationSamplesMs: [],
        ...(foldService ? { service } : {}),
        exemplars: [eventId],
      },
    },
    {
      type: "exemplar",
      priority: 9,
      payload: {
        eventId,
        fingerprint,
        exemplarRole: "first",
        timestamp: new Date().toISOString(),
        type: "exception",
        trace: { traceId: "t-" + eventId, spanId: "s" },
        service: { name: service, version: "1", environment: "test" },
        source: { function: "f", file: "a.ts", line: 1 },
        error: { type: "Error", message: "m", stacktrace: "Error: m" },
      },
    },
  ];
}

async function ingest(list: Envelope["items"]) {
  const res = await app.inject({
    method: "POST",
    url: "/ingest",
    headers: { ...auth, "content-type": "application/x-ndjson" },
    payload: encodeEnvelope({ sentAt: new Date().toISOString(), sdkVersion: "t", items: list }),
  });
  expect(res.statusCode).toBe(202);
}

type Listed = { fingerprint: string; services: string[] };
const list = async (query = "") =>
  (await app.inject({ method: "GET", url: "/issues" + query, headers: auth })).json()
    .issues as Listed[];

describe("issue services", () => {
  beforeAll(async () => {
    await ingest(items("fp-auth", "ev-a1", "auth"));
    await ingest(items("fp-billing", "ev-b1", "billing"));
    await ingest(items("fp-legacy", "ev-l1", "search", false));
  });

  it("each issue lists the service it was seen in", async () => {
    const byFp = new Map((await list()).map((i) => [i.fingerprint, i.services]));
    expect(byFp.get("fp-auth")).toEqual(["auth"]);
    expect(byFp.get("fp-billing")).toEqual(["billing"]);
  });

  it("takes the service from the example event when an older SDK's fold has none", async () => {
    expect((await list()).find((i) => i.fingerprint === "fp-legacy")?.services).toEqual(["search"]);
  });

  it("a second service on the same issue is added, not repeated", async () => {
    await ingest(items("fp-auth", "ev-a2", "auth"));
    await ingest(items("fp-auth", "ev-a3", "gateway"));
    const issue = (await list()).find((i) => i.fingerprint === "fp-auth");
    expect(issue?.services.sort()).toEqual(["auth", "gateway"]);
  });

  it("?service= lists only that service's issues, and pages within it", async () => {
    expect((await list("?service=billing")).map((i) => i.fingerprint)).toEqual(["fp-billing"]);
    expect(await list("?service=nobody")).toEqual([]);

    await ingest(items("fp-auth-2", "ev-a4", "auth"));
    const page = async (cursor?: string) =>
      (
        await app.inject({
          method: "GET",
          url: "/issues?service=auth&limit=1" + (cursor ? "&cursor=" + cursor : ""),
          headers: auth,
        })
      ).json();
    const first = await page();
    expect(first.issues.map((i: Listed) => i.fingerprint)).toEqual(["fp-auth-2"]);
    const second = await page(first.nextCursor);
    expect(second.issues.map((i: Listed) => i.fingerprint)).toEqual(["fp-auth"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("/issues/facets lists every service, sorted", async () => {
    const res = await app.inject({ method: "GET", url: "/issues/facets", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ services: ["auth", "billing", "gateway", "search"] });
  });

  it("/issues/facets needs a key", async () => {
    expect((await app.inject({ method: "GET", url: "/issues/facets" })).statusCode).toBe(401);
  });

  it("issues stored before services existed get theirs from their examples on first read", async () => {
    await db()
      .collection("issues")
      .insertOne({
        fingerprint: "fp-old",
        count: 2,
        userIdSet: [],
        endpointCounts: {},
        durationSamplesMs: [],
        releases: [],
        firstSeen: new Date(Date.now() - 86400000).toISOString(),
        lastSeen: new Date().toISOString(),
        exemplarRefs: [
          { eventId: "ev-o1", role: "first" },
          { eventId: "ev-o2", role: "last" },
        ],
        adjustedCount: 1,
        title: { type: "Error", message: "old" },
      });
    await db()
      .collection("events")
      .insertMany([
        { eventId: "ev-o1", fingerprint: "fp-old", type: "exception", service: { name: "a" } },
        { eventId: "ev-o2", fingerprint: "fp-old", type: "exception", service: { name: "b" } },
      ]);
    expect((await list()).find((i) => i.fingerprint === "fp-old")?.services).toEqual(["a", "b"]);
    const stored = await db().collection("issues").findOne({ fingerprint: "fp-old" });
    expect(stored?.services).toEqual(["a", "b"]);
  });
});
