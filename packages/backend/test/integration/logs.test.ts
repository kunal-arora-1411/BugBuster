import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { Collection, MongoNetworkError } from "mongodb";
import {
  encodeEnvelope,
  MAX_LOG_MESSAGE_CHARS,
  type Envelope,
  type LogEntry,
  type LogLevel,
} from "@bugbusterhq/types";
import { ControlDb } from "../../src/db/control.js";
import { buildServer } from "../../src/build-server.js";
import { TenantDbResolver } from "../../src/db/tenant.js";
import { insertLogs } from "../../src/db/collections/logs.js";
import { _resetOrgCacheForTests } from "../../src/ingest/edge.js";

let mongo: MongoMemoryServer;
let controlDb: ControlDb;
let app: FastifyInstance;

const ORG_A = { orgId: "org_a", name: "Acme", dbName: "bugbuster_org_logs_a", apiKey: "key-a" };
const ORG_B = { orgId: "org_b", name: "Beta", dbName: "bugbuster_org_logs_b", apiKey: "key-b" };

let seq = 0;
function log(partial: Partial<LogEntry> & { message: string }): LogEntry {
  seq++;
  return {
    logId: `log-${seq}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    level: "info",
    service: { name: "checkout-svc", version: "1.0.0", environment: "production" },
    ...partial,
  };
}

function envelopeOf(logs: unknown[]): Envelope {
  return {
    sentAt: new Date().toISOString(),
    sdkVersion: "0.0.0",
    items: logs.map((payload) => ({
      type: "log" as const,
      priority: 1 as const,
      payload: payload as LogEntry,
    })),
  };
}

async function ingest(apiKey: string, ...logs: unknown[]) {
  return app.inject({
    method: "POST",
    url: "/ingest",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/x-ndjson" },
    payload: encodeEnvelope(envelopeOf(logs)),
  });
}

async function getLogs(apiKey: string, qs = "") {
  const res = await app.inject({
    method: "GET",
    url: `/logs${qs}`,
    headers: { authorization: `Bearer ${apiKey}` },
  });
  return {
    status: res.statusCode,
    body: res.json() as { logs: LogEntry[]; nextCursor?: string; error?: string },
  };
}

async function wipe(dbName: string) {
  await controlDb.getClient().db(dbName).collection("logs").deleteMany({});
}

beforeAll(async () => {
  // ttlMonitorSleepSecs=1: MongoDB's TTL monitor normally wakes once a minute; a real expiry test
  // can't wait that long, so the test server wakes it every second.
  mongo = await MongoMemoryServer.create({
    instance: { args: ["--setParameter", "ttlMonitorSleepSecs=1"] },
  });
  controlDb = new ControlDb(mongo.getUri());
  await controlDb.connect();
  await controlDb.createOrg(ORG_A);
  await controlDb.createOrg(ORG_B);
  app = buildServer(
    {
      port: 0,
      controlDbUri: mongo.getUri(),
      ingestMaxBodyBytes: 4 * 1024 * 1024,
      logRetentionDays: 7,
    },
    controlDb,
  );
  await app.ready();
});

beforeEach(async () => {
  _resetOrgCacheForTests();
  await wipe(ORG_A.dbName);
  await wipe(ORG_B.dbName);
});

afterAll(async () => {
  await app.close();
  await controlDb.close();
  await mongo.stop();
});

describe("log ingest -> GET /logs", () => {
  it("stores ingested lines and returns them newest-first in the public shape", async () => {
    const t0 = Date.now();
    const res = await ingest(
      ORG_A.apiKey,
      log({ message: "oldest", timestamp: new Date(t0 - 3000).toISOString() }),
      log({
        message: "middle",
        level: "warn",
        timestamp: new Date(t0 - 2000).toISOString(),
        fields: { orderId: "o_1" },
        trace: { traceId: "trace-1", spanId: "span-1" },
      }),
      log({ message: "newest", level: "error", timestamp: new Date(t0 - 1000).toISOString() }),
    );
    expect(res.statusCode).toBe(202);

    const { status, body } = await getLogs(ORG_A.apiKey);
    expect(status).toBe(200);
    expect(body.logs.map((l) => l.message)).toEqual(["newest", "middle", "oldest"]);
    expect(body.nextCursor).toBeUndefined();

    const middle = body.logs[1];
    expect(middle).toMatchObject({
      level: "warn",
      fields: { orderId: "o_1" },
      trace: { traceId: "trace-1", spanId: "span-1" },
      service: { name: "checkout-svc", version: "1.0.0", environment: "production" },
    });
    // internals never leak into the public contract
    expect(middle).not.toHaveProperty("_id");
    expect(middle).not.toHaveProperty("receivedAt");
  });

  it("is idempotent: re-delivering the same batch (a retry) does not duplicate lines", async () => {
    const batch = [log({ message: "once" }), log({ message: "twice?" })];
    await ingest(ORG_A.apiKey, ...batch);
    await ingest(ORG_A.apiKey, ...batch); // the Agent's retry after a lost 202
    const { body } = await getLogs(ORG_A.apiKey);
    expect(body.logs).toHaveLength(2);
  });

  it("a partially-duplicate batch still stores the genuinely new lines", async () => {
    const dup = log({ message: "already stored" });
    await ingest(ORG_A.apiKey, dup);
    await ingest(ORG_A.apiKey, dup, log({ message: "brand new" }));
    const { body } = await getLogs(ORG_A.apiKey);
    expect(body.logs.map((l) => l.message).sort()).toEqual(["already stored", "brand new"]);
  });

  it("discards schema-invalid lines but stores the valid ones in the same batch", async () => {
    await ingest(
      ORG_A.apiKey,
      log({ message: "valid" }),
      { logId: "bad-1", message: "no level or service" },
      { ...log({ message: "bad level" }), level: "fatal" },
      { ...log({ message: "bad time" }), timestamp: "not-a-date" },
    );
    const { body } = await getLogs(ORG_A.apiKey);
    expect(body.logs.map((l) => l.message)).toEqual(["valid"]);
  });

  it("does not require auth-bypass: a missing or wrong key is 401 and touches nothing", async () => {
    const noAuth = await app.inject({ method: "GET", url: "/logs" });
    expect(noAuth.statusCode).toBe(401);
    const wrong = await app.inject({
      method: "GET",
      url: "/logs",
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.statusCode).toBe(401);
    const facets = await app.inject({ method: "GET", url: "/logs/facets" });
    expect(facets.statusCode).toBe(401);
  });
});

describe("GET /logs — filters", () => {
  beforeEach(async () => {
    const now = Date.now();
    const svc = (name: string, environment = "production") => ({ name, version: "1", environment });
    await ingest(
      ORG_A.apiKey,
      log({
        message: "Payment CAPTURED for o_1042",
        level: "info",
        service: svc("billing"),
        timestamp: new Date(now - 5000).toISOString(),
      }),
      log({
        message: "card declined",
        level: "error",
        service: svc("billing"),
        trace: { traceId: "trace-A" },
        timestamp: new Date(now - 4000).toISOString(),
      }),
      log({
        message: "slow query 2500ms",
        level: "warn",
        service: svc("orders"),
        trace: { traceId: "trace-A" },
        timestamp: new Date(now - 3000).toISOString(),
      }),
      log({
        message: "cache warmed",
        level: "debug",
        service: svc("orders", "staging"),
        timestamp: new Date(now - 2000).toISOString(),
      }),
      log({
        message: "regex chars a.b (x) [y]",
        level: "info",
        service: svc("orders"),
        timestamp: new Date(now - 1000).toISOString(),
      }),
    );
  });

  const messages = async (qs: string) =>
    (await getLogs(ORG_A.apiKey, qs)).body.logs.map((l) => l.message);

  it("level: a single level, and a comma list", async () => {
    expect(await messages("?level=error")).toEqual(["card declined"]);
    expect((await messages("?level=warn,error")).sort()).toEqual([
      "card declined",
      "slow query 2500ms",
    ]);
  });

  it("level matching is case-insensitive on input", async () => {
    expect(await messages("?level=ERROR")).toEqual(["card declined"]);
  });

  it("service and environment", async () => {
    expect((await messages("?service=billing")).sort()).toEqual([
      "Payment CAPTURED for o_1042",
      "card declined",
    ]);
    expect(await messages("?environment=staging")).toEqual(["cache warmed"]);
    expect(await messages("?service=orders&environment=production")).toEqual([
      "regex chars a.b (x) [y]",
      "slow query 2500ms",
    ]);
  });

  it("traceId returns everything that request logged, across services, in order", async () => {
    expect(await messages("?traceId=trace-A")).toEqual(["slow query 2500ms", "card declined"]);
  });

  it("q is a case-insensitive substring match", async () => {
    expect(await messages("?q=captured")).toEqual(["Payment CAPTURED for o_1042"]);
    expect(await messages("?q=o_1042")).toEqual(["Payment CAPTURED for o_1042"]);
    expect(await messages("?q=2500")).toEqual(["slow query 2500ms"]);
  });

  it("q treats regex metacharacters literally (input is never interpreted as a pattern)", async () => {
    expect(await messages("?q=a.b")).toEqual(["regex chars a.b (x) [y]"]);
    expect(await messages("?q=" + encodeURIComponent("(x) [y]"))).toEqual([
      "regex chars a.b (x) [y]",
    ]);
    expect(await messages("?q=" + encodeURIComponent(".*"))).toEqual([]); // would match everything as a regex
    expect(await messages("?q=" + encodeURIComponent("[unclosed"))).toEqual([]); // would be a regex syntax error
  });

  it("from / to bound the time range", async () => {
    const now = Date.now();
    const recent = await messages(
      `?from=${encodeURIComponent(new Date(now - 3500).toISOString())}`,
    );
    expect(recent).toEqual(["regex chars a.b (x) [y]", "cache warmed", "slow query 2500ms"]);
    const window = await messages(
      `?from=${encodeURIComponent(new Date(now - 4500).toISOString())}&to=${encodeURIComponent(new Date(now - 2500).toISOString())}`,
    );
    expect(window).toEqual(["slow query 2500ms", "card declined"]);
  });

  it("filters combine (AND)", async () => {
    expect(await messages("?service=billing&level=error&q=declined")).toEqual(["card declined"]);
    expect(await messages("?service=billing&level=warn")).toEqual([]);
  });
});

describe("GET /logs — pagination", () => {
  it("walks every line exactly once across pages, even when many share one timestamp", async () => {
    const sameInstant = new Date(Date.now() - 10_000).toISOString();
    const lines = Array.from({ length: 25 }, (_, i) =>
      log({ message: `line ${i}`, timestamp: sameInstant }),
    );
    await ingest(ORG_A.apiKey, ...lines);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const { body } = await getLogs(ORG_A.apiKey, `?limit=10${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...body.logs.map((l) => l.logId));
      cursor = body.nextCursor;
      pages++;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25); // no duplicates, no gaps
  });

  it("omits nextCursor on the last page and when everything fits in one", async () => {
    await ingest(ORG_A.apiKey, log({ message: "a" }), log({ message: "b" }));
    expect((await getLogs(ORG_A.apiKey, "?limit=2")).body.nextCursor).toBeUndefined();
    expect((await getLogs(ORG_A.apiKey, "?limit=1")).body.nextCursor).toBeDefined();
  });

  it("caps limit at 500 and ignores a nonsense limit", async () => {
    const tenants = new TenantDbResolver(controlDb.getClient());
    const db = await tenants.forOrgDb(ORG_A.dbName);
    await insertLogs(
      db,
      Array.from({ length: 520 }, (_, i) => log({ message: `bulk ${i}` })),
    );
    expect((await getLogs(ORG_A.apiKey, "?limit=100000")).body.logs).toHaveLength(500);
    expect((await getLogs(ORG_A.apiKey, "?limit=-5")).body.logs).toHaveLength(100); // default
    expect((await getLogs(ORG_A.apiKey, "?limit=abc")).body.logs).toHaveLength(100);
  });

  it("filters stay applied across pages", async () => {
    await ingest(
      ORG_A.apiKey,
      ...Array.from({ length: 12 }, (_, i) =>
        log({ message: `err ${i}`, level: "error" as LogLevel }),
      ),
      ...Array.from({ length: 12 }, (_, i) => log({ message: `inf ${i}` })),
    );
    const first = await getLogs(ORG_A.apiKey, "?level=error&limit=5");
    const second = await getLogs(
      ORG_A.apiKey,
      `?level=error&limit=5&cursor=${first.body.nextCursor}`,
    );
    expect([...first.body.logs, ...second.body.logs].every((l) => l.level === "error")).toBe(true);
    expect(second.body.logs).toHaveLength(5);
  });
});

describe("GET /logs — bad input is a 400, never a silently-wrong answer", () => {
  it.each([
    ["unknown level", "?level=fatal"],
    ["a bad level inside a list", "?level=info,loud"],
    ["unparseable from", "?from=yesterday"],
    ["unparseable to", "?to=%%%"],
    [
      "from after to",
      `?from=${encodeURIComponent("2026-02-01T00:00:00Z")}&to=${encodeURIComponent("2026-01-01T00:00:00Z")}`,
    ],
    ["a forged cursor", "?cursor=not-a-real-cursor"],
  ])("rejects %s", async (_name, qs) => {
    const { status, body } = await getLogs(ORG_A.apiKey, qs);
    expect(status).toBe(400);
    expect(body.error).toBeTruthy();
  });

  it("ignores a repeated parameter (array) instead of mis-parsing it or crashing", async () => {
    await ingest(ORG_A.apiKey, log({ message: "x" }));
    const { status } = await getLogs(ORG_A.apiKey, "?service=a&service=b");
    expect(status).toBe(200);
  });
});

describe("tenant isolation for logs", () => {
  it("org B can never read org A's logs, and each org's lines land only in its own database", async () => {
    await ingest(
      ORG_A.apiKey,
      log({ message: "acme secret", trace: { traceId: "shared-trace-id" } }),
    );
    await ingest(ORG_B.apiKey, log({ message: "beta only" }));

    const a = await getLogs(ORG_A.apiKey);
    const b = await getLogs(ORG_B.apiKey);
    expect(a.body.logs.map((l) => l.message)).toEqual(["acme secret"]);
    expect(b.body.logs.map((l) => l.message)).toEqual(["beta only"]);

    // even knowing org A's exact trace id and search text, org B's key finds nothing
    expect((await getLogs(ORG_B.apiKey, "?traceId=shared-trace-id")).body.logs).toEqual([]);
    expect((await getLogs(ORG_B.apiKey, "?q=acme")).body.logs).toEqual([]);

    // structural check: assert on the underlying databases, not just on responses
    const client = controlDb.getClient();
    expect(
      await client.db(ORG_A.dbName).collection("logs").countDocuments({ message: "acme secret" }),
    ).toBe(1);
    expect(
      await client.db(ORG_B.dbName).collection("logs").countDocuments({ message: "acme secret" }),
    ).toBe(0);
  });

  it("an org's cursor cannot be used to reach another org's data", async () => {
    await ingest(ORG_A.apiKey, ...Array.from({ length: 5 }, (_, i) => log({ message: `a${i}` })));
    await ingest(ORG_B.apiKey, ...Array.from({ length: 5 }, (_, i) => log({ message: `b${i}` })));
    const aPage = await getLogs(ORG_A.apiKey, "?limit=2");
    const bUsingACursor = await getLogs(ORG_B.apiKey, `?limit=10&cursor=${aPage.body.nextCursor}`);
    expect(bUsingACursor.body.logs.every((l) => l.message.startsWith("b"))).toBe(true);
  });

  it("facets are per-org", async () => {
    await ingest(
      ORG_A.apiKey,
      log({ message: "x", service: { name: "acme-svc", version: "1", environment: "prod" } }),
    );
    await ingest(
      ORG_B.apiKey,
      log({ message: "y", service: { name: "beta-svc", version: "1", environment: "dev" } }),
    );
    const res = await app.inject({
      method: "GET",
      url: "/logs/facets",
      headers: { authorization: `Bearer ${ORG_B.apiKey}` },
    });
    expect(res.json()).toEqual({ services: ["beta-svc"], environments: ["dev"] });
  });
});

describe("GET /logs/facets", () => {
  it("lists distinct services and environments, sorted", async () => {
    const svc = (name: string, environment: string) => ({ name, version: "1", environment });
    await ingest(
      ORG_A.apiKey,
      log({ message: "1", service: svc("orders", "production") }),
      log({ message: "2", service: svc("billing", "production") }),
      log({ message: "3", service: svc("orders", "staging") }),
    );
    const res = await app.inject({
      method: "GET",
      url: "/logs/facets",
      headers: { authorization: `Bearer ${ORG_A.apiKey}` },
    });
    expect(res.json()).toEqual({
      services: ["billing", "orders"],
      environments: ["production", "staging"],
    });
  });

  it("is cached per tenant: ingest does not invalidate it, only the TTL does", async () => {
    const get = () =>
      app.inject({
        method: "GET",
        url: "/logs/facets",
        headers: { authorization: `Bearer ${ORG_A.apiKey}` },
      });
    // The server (and its cache) is shared across tests, so the clock starts well past anything
    // an earlier test cached.
    const start = Date.now() + 10 * 60_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    try {
      await ingest(
        ORG_A.apiKey,
        log({ message: "1", service: { name: "first-svc", version: "1", environment: "p" } }),
      );
      expect((await get()).json().services).toEqual(["first-svc"]);
      await ingest(
        ORG_A.apiKey,
        log({ message: "2", service: { name: "second-svc", version: "1", environment: "p" } }),
      );
      // Still the cached value: an active tenant ingests constantly, so invalidating on ingest
      // would mean the cache is never hit.
      clock.mockReturnValue(start + 1_000);
      expect((await get()).json().services).toEqual(["first-svc"]);

      clock.mockReturnValue(start + 61_000);
      expect((await get()).json().services).toEqual(["first-svc", "second-svc"]);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("storage hardening (the wire is untrusted)", () => {
  it("truncates an oversize message and survives keys MongoDB would reject", async () => {
    const res = await ingest(
      ORG_A.apiKey,
      log({
        message: "m".repeat(MAX_LOG_MESSAGE_CHARS * 3),
        fields: { "dotted.key": 1, $dollar: 2, nested: { "a.b": 3, $c: 4 } },
      }),
    );
    expect(res.statusCode).toBe(202);
    const [stored] = (await getLogs(ORG_A.apiKey)).body.logs;
    expect(stored?.message).toHaveLength(MAX_LOG_MESSAGE_CHARS);
    expect(stored?.fields).toEqual({ dotted_key: 1, _dollar: 2, nested: { a_b: 3, _c: 4 } });
  });

  it("replaces an oversize fields object with a truncation marker rather than storing it", async () => {
    const huge: Record<string, string> = {};
    for (let i = 0; i < 40; i++) huge[`k${i}`] = "v".repeat(1000);
    await ingest(ORG_A.apiKey, log({ message: "big fields", fields: huge }));
    const [stored] = (await getLogs(ORG_A.apiKey)).body.logs;
    expect(stored?.fields).toEqual({ _truncated: true });
  });

  it("stamps a far-future client timestamp with the server's time instead of trusting it", async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await ingest(ORG_A.apiKey, log({ message: "from the future", timestamp: future }));
    const [stored] = (await getLogs(ORG_A.apiKey)).body.logs;
    expect(Date.parse(stored!.timestamp)).toBeLessThan(Date.now() + 60_000);
  });
});

describe("a log-insert failure never double-counts folds", () => {
  const fingerprint = "fp-log-order";

  async function ingestFoldAndLog(logEntry: LogEntry) {
    const envelope: Envelope = {
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
            count: 2,
            userIds: [],
            endpointCounts: {},
            durationSamplesMs: [],
            exemplars: [],
          },
        },
        { type: "log", priority: 1, payload: logEntry },
      ],
    };
    return app.inject({
      method: "POST",
      url: "/ingest",
      headers: { authorization: `Bearer ${ORG_A.apiKey}`, "content-type": "application/x-ndjson" },
      payload: encodeEnvelope(envelope),
    });
  }

  const issueCount = async () =>
    (
      await controlDb
        .getClient()
        .db(ORG_A.dbName)
        .collection("issues")
        .findOne({ fingerprint }, { projection: { count: 1 } })
    )?.count;

  beforeEach(async () => {
    await controlDb.getClient().db(ORG_A.dbName).collection("issues").deleteMany({ fingerprint });
  });

  it("a transient insert failure fails the request BEFORE any fold is applied, so the retry counts once", async () => {
    const entry = log({ message: "retried" });
    const insertMany = vi
      .spyOn(Collection.prototype, "insertMany")
      .mockRejectedValueOnce(new MongoNetworkError("socket hang up"));
    try {
      expect((await ingestFoldAndLog(entry)).statusCode).toBe(500);
      expect(await issueCount()).toBeUndefined();
    } finally {
      insertMany.mockRestore();
    }

    expect((await ingestFoldAndLog(entry)).statusCode).toBe(202);
    expect(await issueCount()).toBe(2);
    expect((await getLogs(ORG_A.apiKey)).body.logs.map((l) => l.message)).toEqual(["retried"]);
  });

  it("an unserializable line is discarded on its own; the rest of the batch and the folds land", async () => {
    // The real serializer can no longer be made to fail from wire input (toLogDocument strips what
    // it rejects), so the deterministic client-side failure is simulated for one specific line.
    const poison = log({ message: "poison" });
    const real = Collection.prototype.insertMany;
    const insertMany = vi.spyOn(Collection.prototype, "insertMany").mockImplementation(function (
      this: Collection,
      docs,
      options,
    ) {
      if (docs.some((d) => (d as { logId?: string }).logId === poison.logId)) {
        return Promise.reject(new TypeError("cannot serialize"));
      }
      return real.call(this, docs, options);
    });
    try {
      const fine = log({ message: "fine" });
      const res = await ingest(ORG_A.apiKey, poison, fine);
      expect(res.statusCode).toBe(202);
      expect(await ingestFoldAndLog(log({ message: "with fold" })).then((r) => r.statusCode)).toBe(
        202,
      );
    } finally {
      insertMany.mockRestore();
    }
    const messages = (await getLogs(ORG_A.apiKey)).body.logs.map((l) => l.message).sort();
    expect(messages).toEqual(["fine", "with fold"]);
    expect(await issueCount()).toBe(2);
  });

  it("strips NUL characters from field keys instead of letting the serializer throw", async () => {
    const res = await ingest(ORG_A.apiKey, log({ message: "nul", fields: { "a b": 1 } }));
    expect(res.statusCode).toBe(202);
    const [stored] = (await getLogs(ORG_A.apiKey)).body.logs;
    expect(stored?.fields).toEqual({ ab: 1 });
  });
});

describe("retention", () => {
  const ttlIndex = async (dbName: string) =>
    (await controlDb.getClient().db(dbName).collection("logs").listIndexes().toArray()).find(
      (i) => i.name === "receivedAt_ttl",
    );

  it("creates a TTL index matching the configured retention (7 days here)", async () => {
    await getLogs(ORG_A.apiKey); // first request resolves the tenant and ensures indexes
    expect((await ttlIndex(ORG_A.dbName))?.expireAfterSeconds).toBe(7 * 24 * 60 * 60);
  });

  it("actually deletes expired lines (receivedAt older than retention) and keeps fresh ones", async () => {
    const dbName = "bugbuster_org_ttl_real";
    const tenants = new TenantDbResolver(controlDb.getClient(), { logRetentionDays: 1 });
    const db = await tenants.forOrgDb(dbName);

    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await insertLogs(db, [log({ message: "expired" })], twoDaysAgo);
    await insertLogs(db, [log({ message: "fresh" })]);

    const logs = db.collection("logs");
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && (await logs.countDocuments({ message: "expired" })) > 0) {
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(await logs.countDocuments({ message: "expired" })).toBe(0);
    expect(await logs.countDocuments({ message: "fresh" })).toBe(1);
  }, 30_000);

  it("expires on receivedAt, not the client's timestamp: an old-dated line from a fresh request survives", async () => {
    const dbName = "bugbuster_org_ttl_clock";
    const tenants = new TenantDbResolver(controlDb.getClient(), { logRetentionDays: 1 });
    const db = await tenants.forOrgDb(dbName);
    // client clock wildly in the past, but it only just arrived
    await insertLogs(db, [
      log({ message: "old-dated", timestamp: new Date(Date.now() - 30 * 86400_000).toISOString() }),
    ]);
    await new Promise((r) => setTimeout(r, 3000)); // several TTL monitor passes
    expect(await db.collection("logs").countDocuments({ message: "old-dated" })).toBe(1);
  }, 15_000);

  it("changing the retention setting updates the existing index in place (no migration)", async () => {
    const dbName = "bugbuster_org_ttl_change";
    await new TenantDbResolver(controlDb.getClient(), { logRetentionDays: 7 }).forOrgDb(dbName);
    expect((await ttlIndex(dbName))?.expireAfterSeconds).toBe(7 * 86400);
    await new TenantDbResolver(controlDb.getClient(), { logRetentionDays: 30 }).forOrgDb(dbName);
    expect((await ttlIndex(dbName))?.expireAfterSeconds).toBe(30 * 86400);
  });

  it("retention 0 means keep forever: no TTL index, and a previous one is removed", async () => {
    const dbName = "bugbuster_org_ttl_off";
    await new TenantDbResolver(controlDb.getClient(), { logRetentionDays: 7 }).forOrgDb(dbName);
    expect(await ttlIndex(dbName)).toBeDefined();
    await new TenantDbResolver(controlDb.getClient(), { logRetentionDays: 0 }).forOrgDb(dbName);
    expect(await ttlIndex(dbName)).toBeUndefined();
  });
});
