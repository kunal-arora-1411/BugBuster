import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { encodeEnvelope, ISSUE_TITLE_MAX_CHARS, type Envelope } from "@bugbusterhq/types";
import { ControlDb } from "../../src/db/control.js";
import { buildServer } from "../../src/build-server.js";

const ORG = {
  orgId: "titles",
  name: "Titles",
  dbName: "bugbuster_org_titles",
  apiKey: "titles-key",
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

function items(
  fingerprint: string,
  eventId: string,
  type: string,
  message: string,
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
        service: { name: "svc", version: "1", environment: "test" },
        source: { function: "f", file: "a.ts", line: 1 },
        error: { type, message, stacktrace: `${type}: ${message}` },
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

const listed = async () =>
  (await app.inject({ method: "GET", url: "/issues", headers: auth })).json().issues as {
    fingerprint: string;
    title?: { type: string; message: string };
  }[];

describe("issue titles", () => {
  it("an issue is named by its first example event and returned by /issues and /issues/:fp", async () => {
    await ingest(items("fp-t1", "ev-1", "TypeError", "Cannot read properties of undefined"));
    const issue = (await listed()).find((i) => i.fingerprint === "fp-t1");
    expect(issue?.title).toEqual({
      type: "TypeError",
      message: "Cannot read properties of undefined",
    });
    const one = (await app.inject({ method: "GET", url: "/issues/fp-t1", headers: auth })).json();
    expect(one.title).toEqual(issue?.title);
  });

  it("later examples never rename it", async () => {
    await ingest(items("fp-t2", "ev-2a", "TimeoutError", "first message"));
    await ingest(items("fp-t2", "ev-2b", "TimeoutError", "a different later message"));
    expect((await listed()).find((i) => i.fingerprint === "fp-t2")?.title?.message).toBe(
      "first message",
    );
  });

  it("keeps a long message to ISSUE_TITLE_MAX_CHARS", async () => {
    await ingest(items("fp-t3", "ev-3", "Error", "x".repeat(ISSUE_TITLE_MAX_CHARS * 3)));
    expect((await listed()).find((i) => i.fingerprint === "fp-t3")?.title?.message).toHaveLength(
      ISSUE_TITLE_MAX_CHARS,
    );
  });

  it("issues stored before titles existed get theirs on first read, written back once", async () => {
    // Exactly what an older backend left: an issue with an example reference but no title.
    await db()
      .collection("issues")
      .insertOne({
        fingerprint: "fp-old",
        count: 3,
        userIdSet: [],
        endpointCounts: {},
        durationSamplesMs: [],
        releases: [],
        firstSeen: new Date(Date.now() - 86400000).toISOString(),
        lastSeen: new Date().toISOString(),
        exemplarRefs: [{ eventId: "ev-old", role: "first" }],
        adjustedCount: 1,
      });
    await db()
      .collection("events")
      .insertOne({
        eventId: "ev-old",
        fingerprint: "fp-old",
        type: "exception",
        error: { type: "MongoServerError", message: "E11000 duplicate key", stacktrace: "…" },
      });
    expect((await listed()).find((i) => i.fingerprint === "fp-old")?.title).toEqual({
      type: "MongoServerError",
      message: "E11000 duplicate key",
    });
    expect((await db().collection("issues").findOne({ fingerprint: "fp-old" }))?.title).toEqual({
      type: "MongoServerError",
      message: "E11000 duplicate key",
    });
  });

  it("an issue with no example event yet is listed without a title", async () => {
    await ingest(items("fp-bare", "ev-bare", "Error", "m").slice(0, 1)); // the fold only
    const issue = (await listed()).find((i) => i.fingerprint === "fp-bare");
    expect(issue).toBeDefined();
    expect(issue?.title).toBeUndefined();
  });
});
