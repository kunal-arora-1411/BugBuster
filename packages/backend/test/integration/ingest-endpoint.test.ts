import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { encodeEnvelope, HEADER_CONFIG_VERSION, HEADER_SAMPLE_DIRECTIVE } from "@bugbuster/types";
import type { Envelope } from "@bugbuster/types";
import { ControlDb } from "../../src/db/control.js";
import { buildServer } from "../../src/server.js";
import { _resetOrgCacheForTests } from "../../src/ingest/edge.js";

let mongo: MongoMemoryServer;
let controlDb: ControlDb;
let app: FastifyInstance;

const ORG = {
  orgId: "org_test",
  name: "Test Org",
  dbName: "bugbuster_org_test",
  apiKey: "key-test",
};

function validEnvelope(fingerprint: string): Envelope {
  return {
    sentAt: new Date().toISOString(),
    sdkVersion: "0.0.0",
    items: [
      {
        type: "fold",
        priority: 9,
        payload: {
          fingerprint,
          windowStart: new Date(0).toISOString(),
          windowEnd: new Date().toISOString(),
          count: 3,
          userIds: ["u1"],
          endpointCounts: { "/checkout": 3 },
          durationSamplesMs: [100, 200, 150],
          exemplars: [],
        },
      },
    ],
  };
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  controlDb = new ControlDb(mongo.getUri());
  await controlDb.connect();
  await controlDb.createOrg(ORG);
  app = buildServer({ port: 0, controlDbUri: mongo.getUri(), ingestMaxBodyBytes: 4096 }, controlDb);
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

describe("POST /ingest", () => {
  it("accepts a valid envelope with a correct API key, returns 202 with directive headers", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: {
        authorization: `Bearer ${ORG.apiKey}`,
        "content-type": "application/x-ndjson",
      },
      payload: encodeEnvelope(validEnvelope("fp_ingest_valid")),
    });
    expect(res.statusCode).toBe(202);
    expect(res.headers[HEADER_SAMPLE_DIRECTIVE.toLowerCase()]).toBeDefined();
    expect(res.headers[HEADER_CONFIG_VERSION.toLowerCase()]).toBeDefined();
  });

  it("a valid envelope, once ingested, is retrievable via the Query API with the correct exact count", async () => {
    await app.inject({
      method: "POST",
      url: "/ingest",
      headers: { authorization: `Bearer ${ORG.apiKey}`, "content-type": "application/x-ndjson" },
      payload: encodeEnvelope(validEnvelope("fp_roundtrip")),
    });

    const res = await app.inject({
      method: "GET",
      url: "/issues/fp_roundtrip",
      headers: { authorization: `Bearer ${ORG.apiKey}` },
    });
    expect(res.statusCode).toBe(200);
    const issue = JSON.parse(res.body) as { count: number; fidelity: { isExact: boolean } };
    expect(issue.count).toBe(3);
    expect(issue.fidelity.isExact).toBe(true); // adjustedCount defaults to 1.0
  });

  it("rejects a request with no Authorization header before touching any tenant database", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: { "content-type": "application/x-ndjson" },
      payload: encodeEnvelope(validEnvelope("fp_unauthed")),
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a payload larger than the configured size limit without needing to parse it", async () => {
    const oversized = Buffer.alloc(8192, "a"); // larger than the 4096-byte limit configured above
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: {
        authorization: `Bearer ${ORG.apiKey}`,
        "content-type": "application/x-ndjson",
      },
      payload: oversized,
    });
    expect(res.statusCode).toBe(413);
  });
});
