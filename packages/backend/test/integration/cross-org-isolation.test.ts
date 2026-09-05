import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ControlDb } from "../../src/db/control.js";
import { buildServer } from "../../src/server.js";
import { upsertFoldDelta } from "../../src/db/collections/issues.js";
import { TenantDbResolver } from "../../src/db/tenant.js";
import { _resetOrgCacheForTests } from "../../src/ingest/edge.js";
import type { FoldDelta } from "@bugbuster/types";

/**
 * The single most safety-critical test in the whole system (implementation plan §6): org A's
 * credentials must never be able to reach org B's data, and this asserts it structurally — via
 * the resolved database name actually used — not just "the response happened not to contain it."
 */

let mongo: MongoMemoryServer;
let controlDb: ControlDb;
let app: FastifyInstance;

const ORG_A = { orgId: "org_a", name: "Acme", dbName: "bugbuster_org_acme", apiKey: "key-acme" };
const ORG_B = { orgId: "org_b", name: "Beta", dbName: "bugbuster_org_beta", apiKey: "key-beta" };

function fold(fingerprint: string): FoldDelta {
  return {
    fingerprint,
    windowStart: new Date(0).toISOString(),
    windowEnd: new Date().toISOString(),
    count: 1,
    userIds: [],
    endpointCounts: {},
    durationSamplesMs: [],
    exemplars: [],
  };
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  controlDb = new ControlDb(mongo.getUri());
  await controlDb.connect();
  await controlDb.createOrg(ORG_A);
  await controlDb.createOrg(ORG_B);

  app = buildServer(
    { port: 0, controlDbUri: mongo.getUri(), ingestMaxBodyBytes: 1024 * 1024 },
    controlDb,
  );
  await app.ready();

  // Seed one issue directly into each org's own database, bypassing HTTP, so the test controls
  // exactly what data exists in each database independent of the ingest path under test.
  const tenants = new TenantDbResolver(controlDb.getClient());
  await upsertFoldDelta(await tenants.forOrgDb(ORG_A.dbName), fold("fp_acme_only"));
  await upsertFoldDelta(await tenants.forOrgDb(ORG_B.dbName), fold("fp_beta_only"));
});

beforeEach(() => {
  _resetOrgCacheForTests();
});

afterAll(async () => {
  await app.close();
  await controlDb.close();
  await mongo.stop();
});

describe("cross-org isolation", () => {
  it("org A's API key resolves only org A's own database and sees only its own issue", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/issues",
      headers: { authorization: `Bearer ${ORG_A.apiKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { issues: { fingerprint: string }[] };
    const fingerprints = body.issues.map((i) => i.fingerprint);
    expect(fingerprints).toEqual(["fp_acme_only"]);
    expect(fingerprints).not.toContain("fp_beta_only");
  });

  it("org B's API key resolves only org B's own database and sees only its own issue", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/issues",
      headers: { authorization: `Bearer ${ORG_B.apiKey}` },
    });
    const body = JSON.parse(res.body) as { issues: { fingerprint: string }[] };
    expect(body.issues.map((i) => i.fingerprint)).toEqual(["fp_beta_only"]);
  });

  it("org A cannot fetch org B's issue by fingerprint even when guessing the exact identifier", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/issues/fp_beta_only",
      headers: { authorization: `Bearer ${ORG_A.apiKey}` },
    });
    expect(res.statusCode).toBe(404); // not found in ORG_A's database — it structurally isn't there
  });

  it("resolveOrgForRequest returns a dbName that is exactly the requesting org's own, never the other org's", async () => {
    const { resolveOrgForRequest } = await import("../../src/ingest/edge.js");
    const resolvedA = await resolveOrgForRequest(ORG_A.apiKey, controlDb);
    const resolvedB = await resolveOrgForRequest(ORG_B.apiKey, controlDb);
    expect(resolvedA?.dbName).toBe(ORG_A.dbName);
    expect(resolvedB?.dbName).toBe(ORG_B.dbName);
    expect(resolvedA?.dbName).not.toBe(resolvedB?.dbName);
  });

  it("an unrecognized API key is rejected before any database is ever resolved", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/issues",
      headers: { authorization: "Bearer not-a-real-key" },
    });
    expect(res.statusCode).toBe(401);
  });
});
