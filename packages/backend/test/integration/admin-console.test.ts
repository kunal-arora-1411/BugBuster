import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { encodeEnvelope, type Envelope } from "@bugbusterhq/types";
import { ControlDb, hashApiKey } from "../../src/db/control.js";
import { buildServer } from "../../src/build-server.js";
import { _resetOrgCacheForTests, AUTH_CACHE_TTL_MS } from "../../src/ingest/edge.js";

const ADMIN = "admin-console-test-token-0123456789-abcdef";

let mongo: MongoMemoryServer;
let controlDb: ControlDb;
let app: FastifyInstance;

const config = (uri: string) => ({
  port: 0,
  controlDbUri: uri,
  ingestMaxBodyBytes: 1024 * 1024,
  logRetentionDays: 7,
  adminToken: ADMIN,
});

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  controlDb = new ControlDb(mongo.getUri());
  await controlDb.connect();
  app = buildServer(config(mongo.getUri()), controlDb);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await controlDb.close();
  await mongo.stop();
});

beforeEach(() => _resetOrgCacheForTests());

const admin = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${ADMIN}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });

const asOrg = (key: string, url = "/issues") =>
  app.inject({ method: "GET", url, headers: { authorization: `Bearer ${key}` } });

const ingestAs = (key: string) =>
  app.inject({
    method: "POST",
    url: "/ingest",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/x-ndjson" },
    payload: encodeEnvelope({
      sentAt: new Date().toISOString(),
      sdkVersion: "t",
      items: [],
    } as Envelope),
  });

async function newOrg(orgId: string, extra: Record<string, unknown> = {}) {
  const res = await admin("POST", "/admin/orgs", { orgId, name: `Org ${orgId}`, ...extra });
  expect(res.statusCode).toBe(201);
  return res.json() as { apiKey: string; keyId: string; dbName: string };
}

describe("named keys", () => {
  it("an org can have several keys; revoking one leaves the others working", async () => {
    const org = await newOrg("multi", { keyName: "checkout-api" });
    const second = await admin("POST", "/admin/orgs/multi/keys", { name: "orders-worker" });
    expect(second.statusCode).toBe(201);
    expect(second.headers["cache-control"]).toBe("no-store");
    const worker = second.json() as { apiKey: string; keyId: string; name: string };
    expect(worker.name).toBe("orders-worker");

    expect((await asOrg(org.apiKey)).statusCode).toBe(200);
    expect((await asOrg(worker.apiKey)).statusCode).toBe(200);

    const revoked = await admin("DELETE", `/admin/orgs/multi/keys/${worker.keyId}`);
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().revokedAt).toBeTruthy();
    expect((await asOrg(worker.apiKey)).statusCode).toBe(401); // same process: at once
    expect((await asOrg(org.apiKey)).statusCode).toBe(200);
    expect((await admin("DELETE", `/admin/orgs/multi/keys/${worker.keyId}`)).statusCode).toBe(200); // twice is fine
  });

  it("a key revoked by another backend instance stops working once this instance's cache expires", async () => {
    const org = await newOrg("ttl");
    expect((await asOrg(org.apiKey)).statusCode).toBe(200); // now cached here
    // Another instance revokes it: this process is not told.
    await controlDb.revokeKey("ttl", org.keyId);
    expect((await asOrg(org.apiKey)).statusCode).toBe(200); // still within the cache window

    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + AUTH_CACHE_TTL_MS + 1000);
    try {
      expect((await asOrg(org.apiKey)).statusCode).toBe(401);
    } finally {
      clock.mockRestore();
    }
  });

  it("records when a key was last used, without a write on every request", async () => {
    const org = await newOrg("used");
    const touch = vi.spyOn(controlDb, "touchKey");
    try {
      for (let i = 0; i < 5; i++) await asOrg(org.apiKey);
      expect(touch).toHaveBeenCalledTimes(1);
    } finally {
      touch.mockRestore();
    }
    await new Promise((r) => setTimeout(r, 50)); // the touch is fire-and-forget
    const keys = (await admin("GET", "/admin/orgs"))
      .json()
      .orgs.find((o: { orgId: string }) => o.orgId === "used").keys;
    expect(keys[0].lastUsedAt).toBeTruthy();
  });

  it("validates key names and refuses unknown orgs and keys", async () => {
    await newOrg("val");
    expect((await admin("POST", "/admin/orgs/val/keys", { name: "" })).statusCode).toBe(400);
    expect(
      (await admin("POST", "/admin/orgs/val/keys", { name: "x".repeat(101) })).statusCode,
    ).toBe(400);
    expect((await admin("POST", "/admin/orgs/nobody/keys", { name: "k" })).statusCode).toBe(404);
    expect((await admin("DELETE", "/admin/orgs/val/keys/key_nope")).statusCode).toBe(404);
    expect(
      (await admin("POST", "/admin/orgs", { orgId: "val2", name: "x", keyName: "" })).statusCode,
    ).toBe(400);
  });
});

describe("disabling an organization", () => {
  it("refuses its keys with 403 for reading and sending until it is enabled again; data is kept", async () => {
    const org = await newOrg("off");
    expect((await ingestAs(org.apiKey)).statusCode).toBe(202);

    const off = await admin("PATCH", "/admin/orgs/off", { disabled: true });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ disabled: true });
    expect(off.json().disabledAt).toBeTruthy();

    for (const res of [
      await asOrg(org.apiKey),
      await asOrg(org.apiKey, "/logs"),
      await ingestAs(org.apiKey),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "organization is disabled" });
    }

    const on = await admin("PATCH", "/admin/orgs/off", { disabled: false });
    expect(on.json()).toMatchObject({ disabled: false });
    expect(on.json().disabledAt).toBeUndefined();
    expect((await asOrg(org.apiKey)).statusCode).toBe(200);
  });

  it("renames, and rejects an empty or meaningless change", async () => {
    await newOrg("named");
    const res = await admin("PATCH", "/admin/orgs/named", { name: "  Acme Retail  " });
    expect(res.json().name).toBe("Acme Retail");
    expect((await admin("PATCH", "/admin/orgs/named", {})).statusCode).toBe(400);
    expect((await admin("PATCH", "/admin/orgs/named", { disabled: "yes" })).statusCode).toBe(400);
    expect((await admin("PATCH", "/admin/orgs/named", { name: "" })).statusCode).toBe(400);
  });
});

describe("GET /admin/orgs", () => {
  it("lists orgs with status, retention and keys, and never a key or its hash", async () => {
    await newOrg("listed", { logRetentionDays: 30 });
    const res = await admin("GET", "/admin/orgs");
    expect(res.statusCode).toBe(200);
    const listed = res.json().orgs.find((o: { orgId: string }) => o.orgId === "listed");
    expect(listed).toMatchObject({
      disabled: false,
      logRetentionDays: 30,
      retentionOverridden: true,
    });
    expect(listed.keys).toHaveLength(1);
    expect(listed.keys[0]).toMatchObject({ name: "Default key", orgId: "listed" });
    expect(res.body).not.toMatch(/keyHash|apiKeyHash|"apiKey"/);
    expect((await app.inject({ method: "GET", url: "/admin/orgs" })).statusCode).toBe(401);
  });
});

describe("JSON bodies", () => {
  it("an empty body with a JSON content type is accepted; malformed JSON is a 400", async () => {
    const org = await newOrg("bodies");
    const del = await app.inject({
      method: "DELETE",
      url: `/admin/orgs/bodies/keys/${org.keyId}`,
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    });
    expect(del.statusCode).toBe(200);
    const bad = await app.inject({
      method: "PATCH",
      url: "/admin/orgs/bodies",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      payload: "{not json",
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe("change history", () => {
  it("records each admin change", async () => {
    const org = await newOrg("hist");
    await admin("POST", "/admin/orgs/hist/keys", { name: "second" });
    await admin("PATCH", "/admin/orgs/hist", { logRetentionDays: 14, disabled: true });
    await admin("DELETE", `/admin/orgs/hist/keys/${org.keyId}`);
    const events = (await admin("GET", "/admin/events?limit=200"))
      .json()
      .events.filter((e: { orgId?: string }) => e.orgId === "hist");
    expect(events.map((e: { action: string }) => e.action)).toEqual([
      "key.revoked",
      "org.disabled",
      "org.retention_changed",
      "key.created",
      "org.created",
    ]);
    expect(
      events.find((e: { action: string }) => e.action === "org.retention_changed").detail,
    ).toBe("14 days");
  });
});

describe("cleanup from the admin API", () => {
  it("counts with dryRun, then deletes", async () => {
    const org = await newOrg("tidy");
    await controlDb
      .getClient()
      .db(org.dbName)
      .collection("events")
      .insertOne({
        _id: new (await import("mongodb")).ObjectId(Math.floor(Date.now() / 1000) - 3600),
        eventId: "orphan",
      });
    const dry = await admin("POST", "/admin/maintenance/cleanup-events", {
      dryRun: true,
      orgId: "tidy",
    });
    expect(dry.json()).toEqual({ dryRun: true, total: 1, orgs: [{ orgId: "tidy", events: 1 }] });
    const real = await admin("POST", "/admin/maintenance/cleanup-events", { orgId: "tidy" });
    expect(real.json()).toMatchObject({ dryRun: false, total: 1 });
    expect(
      (await admin("POST", "/admin/maintenance/cleanup-events", { orgId: "tidy" })).json().total,
    ).toBe(0);
  });
});

describe("the admin page", () => {
  it("is served with a strict content policy where admin is enabled, and is a 404 elsewhere", async () => {
    const res = await app.inject({ method: "GET", url: "/admin" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/html/);
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["content-security-policy"]).toContain("connect-src 'self'");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toContain("Sign in to admin");

    const plain = buildServer({ ...config(mongo.getUri()), adminToken: undefined }, controlDb);
    expect((await plain.inject({ method: "GET", url: "/admin" })).statusCode).toBe(404);
    await plain.close();
  });
});

describe("orgs from before named keys", () => {
  it("keep working: their key is copied in as 'Original key', and new orgs can be created", async () => {
    const uri = mongo.getUri();
    const control = controlDb.getClient().db("bugbuster_control");
    // An org exactly as an older backend stored it, with the old unique index in place.
    await control
      .collection("orgs")
      .dropIndex("apiKeyHash_1")
      .catch(() => {});
    await control.collection("orgs").createIndex({ apiKeyHash: 1 }, { unique: true, sparse: true });
    await control.collection("orgs").insertOne({
      orgId: "legacy",
      name: "Legacy",
      dbName: "bugbuster_org_legacy",
      apiKeyHash: hashApiKey("legacy-api-key"),
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    // A backend starting with this release (another ControlDb, as a new instance would).
    const fresh = new ControlDb(uri);
    await fresh.connect();
    await fresh.connect(); // a second instance starting too: nothing is duplicated
    const freshApp = buildServer(config(uri), fresh);
    try {
      const keys = await fresh.listKeys("legacy");
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatchObject({
        name: "Original key",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const ok = await freshApp.inject({
        method: "GET",
        url: "/issues",
        headers: { authorization: "Bearer legacy-api-key" },
      });
      expect(ok.statusCode).toBe(200);

      // The old unique index is gone, so several orgs without apiKeyHash can exist.
      for (const id of ["after-a", "after-b"]) {
        const r = await freshApp.inject({
          method: "POST",
          url: "/admin/orgs",
          headers: { authorization: `Bearer ${ADMIN}` },
          payload: { orgId: id, name: id },
        });
        expect(r.statusCode).toBe(201);
      }

      // Revoking the original key also clears it from the org record old backends read.
      const revoked = await freshApp.inject({
        method: "DELETE",
        url: `/admin/orgs/legacy/keys/${keys[0]!.keyId}`,
        headers: { authorization: `Bearer ${ADMIN}` },
      });
      expect(revoked.statusCode).toBe(200);
      expect(
        (await control.collection("orgs").findOne({ orgId: "legacy" }))?.apiKeyHash,
      ).toBeUndefined();
      _resetOrgCacheForTests();
      const after = await freshApp.inject({
        method: "GET",
        url: "/issues",
        headers: { authorization: "Bearer legacy-api-key" },
      });
      expect(after.statusCode).toBe(401);
    } finally {
      await freshApp.close();
      await fresh.close();
    }
  });
});
