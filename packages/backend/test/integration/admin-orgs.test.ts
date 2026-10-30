import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { BackendConfigSchema } from "@bugbusterhq/types";
import { ControlDb } from "../../src/db/control.js";
import { buildServer } from "../../src/build-server.js";

const ADMIN_TOKEN = "test-admin-token-0123456789-abcdefghij";

let mongo: MongoMemoryServer;
let controlDb: ControlDb;
let app: FastifyInstance;
let appWithoutAdmin: FastifyInstance;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  controlDb = new ControlDb(mongo.getUri());
  await controlDb.connect();
  const config = { port: 0, controlDbUri: mongo.getUri(), ingestMaxBodyBytes: 65536 };
  app = buildServer({ ...config, adminToken: ADMIN_TOKEN }, controlDb);
  appWithoutAdmin = buildServer(config, controlDb);
  await Promise.all([app.ready(), appWithoutAdmin.ready()]);
});

afterAll(async () => {
  await app.close();
  await appWithoutAdmin.close();
  await controlDb.close();
  await mongo.stop();
});

/** `token: null` sends no Authorization header at all. */
function createOrg(body: unknown, token: string | null = ADMIN_TOKEN, server = app) {
  return server.inject({
    method: "POST",
    url: "/admin/orgs",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: body as Record<string, unknown>,
  });
}

describe("POST /admin/orgs", () => {
  it("creates an org and returns a working API key, shown once and never stored in plain text", async () => {
    const res = await createOrg({ orgId: "acme", name: "Acme Corp" });
    expect(res.statusCode).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json() as { orgId: string; name: string; dbName: string; apiKey: string };
    expect(body).toMatchObject({ orgId: "acme", name: "Acme Corp", dbName: "bugbuster_org_acme" });
    expect(body.apiKey).toMatch(/^bb_[A-Za-z0-9_-]{43}$/);

    // The key authenticates the org's own routes...
    const issues = await app.inject({
      method: "GET",
      url: "/issues",
      headers: { authorization: `Bearer ${body.apiKey}` },
    });
    expect(issues.statusCode).toBe(200);

    // ...and only its hash is in the database.
    const stored = await controlDb
      .getClient()
      .db("bugbuster_control")
      .collection("orgs")
      .findOne({ orgId: "acme" });
    expect(JSON.stringify(stored)).not.toContain(body.apiKey);
  });

  it("generates a different key every time", async () => {
    const a = (await createOrg({ orgId: "uniq-a", name: "A" })).json().apiKey;
    const b = (await createOrg({ orgId: "uniq-b", name: "B" })).json().apiKey;
    expect(a).not.toBe(b);
  });

  it("refuses a duplicate orgId with 409", async () => {
    expect((await createOrg({ orgId: "dupe", name: "First" })).statusCode).toBe(201);
    expect((await createOrg({ orgId: "dupe", name: "Second" })).statusCode).toBe(409);
  });

  it("refuses an orgId whose database another org already uses (409), protecting isolation", async () => {
    // An org created by the CLI can name its database anything — including what a new id derives.
    await controlDb.createOrg({
      orgId: "legacy",
      name: "Legacy",
      dbName: "bugbuster_org_taken",
      apiKey: "legacy-key",
    });
    const res = await createOrg({ orgId: "taken", name: "Would share a database" });
    expect(res.statusCode).toBe(409);
  });

  it("validates orgId and name (400)", async () => {
    for (const body of [
      {},
      { orgId: "Acme", name: "uppercase" },
      { orgId: "has space", name: "x" },
      { orgId: "a".repeat(41), name: "too long" },
      { orgId: "../evil", name: "x" },
      { orgId: "ok", name: "" },
      { orgId: "ok", name: "n".repeat(201) },
    ]) {
      expect((await createOrg(body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it("rejects a missing or wrong admin token (401) — and an org's API key is not an admin token", async () => {
    expect((await createOrg({ orgId: "nope1", name: "x" }, null)).statusCode).toBe(401);
    expect((await createOrg({ orgId: "nope2", name: "x" }, "wrong")).statusCode).toBe(401);
    expect((await createOrg({ orgId: "nope3", name: "x" }, "legacy-key")).statusCode).toBe(401);
  });

  it("does not exist (404) when the backend has no admin token configured", async () => {
    const res = await createOrg({ orgId: "nope4", name: "x" }, ADMIN_TOKEN, appWithoutAdmin);
    expect(res.statusCode).toBe(404);
  });
});

describe("adminToken config", () => {
  it("rejects an admin token shorter than 32 characters at startup", () => {
    const base = { controlDbUri: "mongodb://x" };
    expect(() => BackendConfigSchema.parse({ ...base, adminToken: "short" })).toThrow(/32/);
    expect(BackendConfigSchema.parse({ ...base, adminToken: ADMIN_TOKEN }).adminToken).toBe(
      ADMIN_TOKEN,
    );
  });
});
