import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { encodeEnvelope, type Envelope, type FoldDelta } from "@bugbusterhq/types";
import { ControlDb } from "../../src/db/control.js";
import { buildServer } from "../../src/build-server.js";

const ORG = { orgId: "rc", name: "Root cause", dbName: "bugbuster_org_rc", apiKey: "rc-key" };
const OTHER = { orgId: "rc2", name: "Other", dbName: "bugbuster_org_rc2", apiKey: "rc2-key" };

let mongo: MongoMemoryServer;
let controlDb: ControlDb;
let app: FastifyInstance;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  controlDb = new ControlDb(mongo.getUri());
  await controlDb.connect();
  await controlDb.createOrg(ORG);
  await controlDb.createOrg(OTHER);
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

const fp = (n: number) => `fp_${n.toString(16).padStart(16, "0")}`;
const INVENTORY = fp(1);
const ORDERS = fp(2);
const CHECKOUT = fp(3);

let eventSeq = 0;

/** One fold for `fingerprint`, with an example event so the issue has a title. */
function fold(
  fingerprint: string,
  service: string,
  count: number,
  causedBy?: Record<string, number>,
): Envelope["items"] {
  const eventId = `ev-${++eventSeq}`;
  const payload: FoldDelta = {
    fingerprint,
    windowStart: new Date(0).toISOString(),
    windowEnd: new Date().toISOString(),
    count,
    userIds: [],
    endpointCounts: {},
    durationSamplesMs: [],
    service,
    exemplars: [eventId],
    ...(causedBy ? { causedBy } : {}),
  };
  return [
    { type: "fold", priority: 9, payload },
    {
      type: "exemplar",
      priority: 9,
      payload: {
        eventId,
        fingerprint,
        exemplarRole: "first",
        timestamp: new Date().toISOString(),
        type: "exception",
        trace: { traceId: "t", spanId: "s" },
        service: { name: service, version: "1", environment: "test" },
        source: { function: "f", file: "a.ts", line: 1 },
        error: { type: "Error", message: `${service} failed`, stacktrace: "" },
        ...(causedBy ? { causedBy: Object.keys(causedBy)[0] } : {}),
      },
    },
  ];
}

async function ingest(items: Envelope["items"], apiKey = ORG.apiKey): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: "/ingest",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/x-ndjson" },
    payload: encodeEnvelope({ sentAt: new Date().toISOString(), sdkVersion: "test", items }),
  });
  expect(res.statusCode).toBe(202);
}

async function get(url: string, apiKey = ORG.apiKey) {
  const res = await app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${apiKey}` },
  });
  return { status: res.statusCode, body: res.json() };
}

describe("root cause across services", () => {
  beforeAll(async () => {
    // inventory's timeout (root) -> orders' 500 -> checkout's failure; 10 of each.
    await ingest([
      ...fold(INVENTORY, "inventory", 10),
      ...fold(ORDERS, "orders", 10, { [INVENTORY]: 9 }),
      ...fold(CHECKOUT, "checkout", 10, { [ORDERS]: 8 }),
    ]);
  });

  it("stores one link per cause/effect pair, summing counts across envelopes", async () => {
    await ingest(fold(ORDERS, "orders", 1, { [INVENTORY]: 1 }));
    const link = await controlDb
      .getClient()
      .db(ORG.dbName)
      .collection("issue_links")
      .findOne({ cause: INVENTORY, effect: ORDERS });
    expect(link?.count).toBe(10);
    expect(link?.firstSeen).toBeTypeOf("string");
  });

  it("GET /issues gives a symptom its strongest cause, with the share it explains", async () => {
    const { body } = await get("/issues");
    const byFp = new Map(body.issues.map((i: { fingerprint: string }) => [i.fingerprint, i]));
    expect((byFp.get(ORDERS) as { causedBy: unknown }).causedBy).toEqual({
      fingerprint: INVENTORY,
      count: 10,
      share: 10 / 11,
    });
    expect((byFp.get(INVENTORY) as { causedBy?: unknown }).causedBy).toBeUndefined();
  });

  it("GET /issues/:fp/causes walks a symptom of a symptom up to the root cause", async () => {
    const { status, body } = await get(`/issues/${CHECKOUT}/causes`);
    expect(status).toBe(200);
    expect(body.rootCause.issue.fingerprint).toBe(INVENTORY);
    expect(body.rootCause.issue.title).toEqual({ type: "Error", message: "inventory failed" });
    expect(body.rootCause.path).toEqual([CHECKOUT, ORDERS, INVENTORY]);
    expect(body.causedBy).toHaveLength(1);
    expect(body.causedBy[0]).toMatchObject({ count: 8, share: 0.8 });
    expect(body.causedBy[0].issue.fingerprint).toBe(ORDERS);
    expect(body.caused).toEqual([]);
  });

  it("the root cause lists what it caused, and is not a symptom itself", async () => {
    const { body } = await get(`/issues/${INVENTORY}/causes`);
    expect(body.rootCause).toBeNull();
    expect(body.causedBy).toEqual([]);
    expect(body.caused.map((e: { issue: { fingerprint: string } }) => e.issue.fingerprint)).toEqual(
      [ORDERS],
    );
    expect(body.caused[0].share).toBeCloseTo(10 / 11);
  });

  it("a weak cause is listed, but does not make the issue a symptom", async () => {
    const weak = fp(10);
    await ingest(fold(weak, "billing", 10, { [INVENTORY]: 2 }));
    const { body } = await get(`/issues/${weak}/causes`);
    expect(body.rootCause).toBeNull();
    expect(body.causedBy[0]).toMatchObject({ count: 2, share: 0.2 });
  });

  it("ignores a cause no issue here has, a self-link, and a malformed key", async () => {
    const lonely = fp(20);
    await ingest(
      fold(lonely, "search", 4, {
        [fp(999)]: 4, // heard from a service that reports to another org
        [lonely]: 4,
        "not-a-fingerprint": 4,
      }),
    );
    const links = await controlDb
      .getClient()
      .db(ORG.dbName)
      .collection("issue_links")
      .find({ effect: lonely })
      .toArray();
    expect(links.map((l) => l.cause)).toEqual([fp(999)]); // stored: it may get an issue later
    const { body } = await get(`/issues/${lonely}/causes`);
    expect(body.causedBy).toEqual([]);
    expect(body.rootCause).toBeNull();
    expect((await get(`/issues/${lonely}`)).body.causedBy).toBeUndefined();
  });

  it("stops on a cycle instead of walking forever", async () => {
    const a = fp(30);
    const b = fp(31);
    await ingest([...fold(a, "a", 5, { [b]: 5 }), ...fold(b, "b", 5, { [a]: 5 })]);
    const { body } = await get(`/issues/${a}/causes`);
    expect(body.rootCause.path).toEqual([a, b]);
  });

  it("another organization sees none of it", async () => {
    expect((await get(`/issues/${CHECKOUT}/causes`, OTHER.apiKey)).status).toBe(404);
  });

  it("answers 404 for an unknown fingerprint", async () => {
    expect((await get(`/issues/${fp(12345)}/causes`)).status).toBe(404);
  });
});
