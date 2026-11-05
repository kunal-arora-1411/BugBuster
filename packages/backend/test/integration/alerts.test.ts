import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Db } from "mongodb";
import { encodeEnvelope, type Envelope } from "@bugbusterhq/types";
import { ControlDb } from "../../src/db/control.js";
import { buildServer, createServer } from "../../src/build-server.js";
import type { AlertNotifier } from "../../src/alerts/notifier.js";
import type { AlertEmail, Mailer } from "../../src/alerts/brevo.js";
import { _resetOrgCacheForTests } from "../../src/ingest/edge.js";

const ADMIN = "alerts-test-admin-token-0123456789-abcdef";
const CRON = "alerts-test-cron-secret-0123";

/** Stands in for Brevo: records what would have been sent, or fails like Brevo would. */
class FakeMailer implements Mailer {
  sent: { to: string[]; email: AlertEmail }[] = [];
  failWith: Error | undefined;
  async send(to: readonly string[], email: AlertEmail): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.sent.push({ to: [...to], email });
  }
}

let mongo: MongoMemoryServer;
let controlDb: ControlDb;
let app: FastifyInstance;
let notifier: AlertNotifier;
const mailer = new FakeMailer();

const baseConfig = (uri: string) => ({
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
  const server = createServer(
    {
      ...baseConfig(mongo.getUri()),
      cronSecret: CRON,
      alerts: {
        brevoApiKey: "unused-by-the-fake",
        from: "alerts@bugbuster.example.com",
        fromName: "BugBuster",
        dashboardUrl: "https://dash.example.com/",
        maxEmailsPerHour: 2,
      },
    },
    controlDb,
    { mailer },
  );
  app = server.app;
  notifier = server.notifier!;
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await controlDb.close();
  await mongo.stop();
});

beforeEach(() => {
  _resetOrgCacheForTests();
  mailer.sent = [];
  mailer.failWith = undefined;
});

const admin = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${ADMIN}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });

let orgCount = 0;
/** A fresh org (each test gets its own, so their alerts never mix). */
async function newOrg() {
  const orgId = `alerts${++orgCount}`;
  const apiKey = `${orgId}-key`;
  await controlDb.createOrg({
    orgId,
    name: `Org ${orgCount}`,
    dbName: `bugbuster_org_${orgId}`,
    apiKey,
  });
  return { orgId, apiKey, db: () => controlDb.getClient().db(`bugbuster_org_${orgId}`) };
}

async function setAlerts(orgId: string, body: Record<string, unknown>) {
  const res = await admin("PUT", `/admin/orgs/${orgId}/alerts`, body);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

type ErrorSpec = {
  fp: string;
  service?: string;
  environment?: string;
  type?: string;
  message?: string;
  /** The function the error was thrown in; with the message, what makes two errors the same. */
  fn?: string;
};

function items(e: ErrorSpec): Envelope["items"] {
  const eventId = `ev-${e.fp}-${Math.random().toString(36).slice(2)}`;
  return [
    {
      type: "fold",
      priority: 9,
      payload: {
        fingerprint: e.fp,
        windowStart: new Date(0).toISOString(),
        windowEnd: new Date().toISOString(),
        count: 3,
        userIds: [],
        endpointCounts: { "POST /api/checkout": 3 },
        durationSamplesMs: [],
        service: e.service ?? "orders-api",
        exemplars: [eventId],
      },
    },
    {
      type: "exemplar",
      priority: 9,
      payload: {
        eventId,
        fingerprint: e.fp,
        exemplarRole: "first",
        timestamp: new Date().toISOString(),
        type: "exception",
        trace: { traceId: "t", spanId: "s" },
        service: {
          name: e.service ?? "orders-api",
          version: "1.2.3",
          environment: e.environment ?? "production",
        },
        source: { function: e.fn ?? "computeTotals", file: "src/cart.ts", line: 42 },
        error: {
          type: e.type ?? "TypeError",
          message: e.message ?? `Cannot read properties of undefined (reading '${e.fp}')`,
          stacktrace:
            `${e.type ?? "TypeError"}: boom\n    at ${e.fn ?? "computeTotals"} (src/cart.ts:42:9)\n` +
            "    at handle (src/http/router.ts:88:5)",
        },
      },
    },
  ];
}

async function ingest(apiKey: string, ...errors: ErrorSpec[]) {
  const res = await app.inject({
    method: "POST",
    url: "/ingest",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/x-ndjson" },
    payload: encodeEnvelope({
      sentAt: new Date().toISOString(),
      sdkVersion: "t",
      items: errors.flatMap(items),
    }),
  });
  expect(res.statusCode).toBe(202);
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Alerts go out after the ingest response; wait for them (or for nothing to happen). */
async function waitForEmails(n: number, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (mailer.sent.length < n && Date.now() < end) await pause(20);
  await pause(150); // and make sure no extra one follows
}

/** Fingerprints still waiting for their alert. */
const pending = async (db: () => Db) =>
  (
    await db()
      .collection("issues")
      .find({ alertPendingAt: { $exists: true } })
      .toArray()
  ).map((d) => d.fingerprint);

describe("alert settings", () => {
  it("validates what the admin page sends", async () => {
    const { orgId } = await newOrg();
    const put = (body: Record<string, unknown>) =>
      admin("PUT", `/admin/orgs/${orgId}/alerts`, body);
    expect((await put({})).json().error).toBe("enabled must be true or false");
    expect((await put({ enabled: true, recipients: [] })).json().error).toBe(
      "add at least one recipient to switch alerts on",
    );
    expect((await put({ enabled: true, recipients: ["not-an-email"] })).json().error).toBe(
      '"not-an-email" is not an email address',
    );
    expect(
      (await put({ enabled: true, recipients: Array.from({ length: 21 }, (_, i) => `u${i}@x.io`) }))
        .statusCode,
    ).toBe(400);
    expect(
      (await put({ enabled: true, recipients: ["a@x.io"], services: "orders" })).statusCode,
    ).toBe(400);
    expect((await admin("PUT", "/admin/orgs/nobody/alerts", { enabled: false })).statusCode).toBe(
      404,
    );
  });

  it("saves them, without repeats, and shows them on the org", async () => {
    const { orgId } = await newOrg();
    const org = await setAlerts(orgId, {
      enabled: true,
      recipients: [" Dev@Example.com ", "dev@example.com", "oncall@example.com"],
      services: ["orders-api", " orders-api"],
      environments: ["production"],
    });
    expect(org.alerts).toMatchObject({
      enabled: true,
      recipients: ["Dev@Example.com", "oncall@example.com"],
      services: ["orders-api"],
      environments: ["production"],
      includeStack: true,
      sentLastHour: 0,
    });
    expect(org.alerts.since).toBeDefined();
    const listed = (await admin("GET", "/admin/orgs")).json();
    expect(listed.emailAlerts).toEqual({ configured: true, from: "alerts@bugbuster.example.com" });
    const events = (await admin("GET", "/admin/events")).json().events;
    expect(events[0]).toMatchObject({
      action: "org.alerts_changed",
      orgId,
      detail: "on, 2 recipients",
    });
  });

  it("switching alerts on again restarts `since`; saving while on keeps it", async () => {
    const { orgId } = await newOrg();
    const first = (await setAlerts(orgId, { enabled: true, recipients: ["a@x.io"] })).alerts.since;
    await pause(5);
    expect((await setAlerts(orgId, { enabled: true, recipients: ["b@x.io"] })).alerts.since).toBe(
      first,
    );
    await setAlerts(orgId, { enabled: false, recipients: ["b@x.io"] });
    await pause(5);
    expect(
      (await setAlerts(orgId, { enabled: true, recipients: ["b@x.io"] })).alerts.since > first,
    ).toBe(true);
  });
});

describe("alert emails", () => {
  it("a new error emails each recipient once, with the error, where it happened and a link", async () => {
    const { orgId, apiKey, db } = await newOrg();
    await setAlerts(orgId, {
      enabled: true,
      recipients: ["dev@example.com", "oncall@example.com"],
    });
    await ingest(apiKey, { fp: "fp-new", message: "<script>alert(1)</script> & more" });
    await waitForEmails(1);

    expect(mailer.sent).toHaveLength(1);
    const [{ to, email }] = mailer.sent;
    expect(to).toEqual(["dev@example.com", "oncall@example.com"]);
    expect(email.subject).toBe(
      "New error in orders-api · production: TypeError: <script>alert(1)</script> & more",
    );
    // Application text is escaped in the HTML, never markup.
    expect(email.html).not.toContain("<script>alert(1)</script>");
    expect(email.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; more");
    expect(email.html).toContain("https://dash.example.com/#issues/fp-new");
    expect(email.html).toContain("POST /api/checkout");
    expect(email.text).toContain("at computeTotals (src/cart.ts:42:9)");
    expect(email.text).toContain("3 events so far");
    expect(await pending(db)).toEqual([]);

    // The same error again is not new.
    await ingest(apiKey, { fp: "fp-new" });
    await waitForEmails(2, 300);
    expect(mailer.sent).toHaveLength(1);

    const org = (await admin("GET", "/admin/orgs"))
      .json()
      .orgs.find((o: { orgId: string }) => o.orgId === orgId);
    expect(org.alerts.sentLastHour).toBe(1);
    expect(org.alerts.lastSentAt).toBeDefined();
  });

  it("errors that arrive together share one email", async () => {
    const { orgId, apiKey } = await newOrg();
    await setAlerts(orgId, { enabled: true, recipients: ["dev@example.com"] });
    await ingest(
      apiKey,
      { fp: "fp-a", type: "TypeError" },
      { fp: "fp-b", type: "RangeError", service: "billing" },
    );
    await waitForEmails(1);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.email.subject).toBe("2 new errors in orders-api, billing");
    expect(mailer.sent[0]!.email.text).toContain("RangeError");
  });

  it("leaves out the stack trace when asked to", async () => {
    const { orgId, apiKey } = await newOrg();
    await setAlerts(orgId, { enabled: true, recipients: ["dev@example.com"], includeStack: false });
    await ingest(apiKey, { fp: "fp-nostack" });
    await waitForEmails(1);
    expect(mailer.sent[0]!.email.text).not.toContain("computeTotals (src/cart.ts");
  });

  it("only the chosen services and environments alert; the others are dropped, not kept", async () => {
    const { orgId, apiKey, db } = await newOrg();
    await setAlerts(orgId, {
      enabled: true,
      recipients: ["dev@example.com"],
      services: ["orders-api"],
      environments: ["production"],
    });
    await ingest(apiKey, { fp: "fp-other-service", service: "billing" });
    await ingest(apiKey, { fp: "fp-staging", environment: "staging" });
    await waitForEmails(1, 400);
    expect(mailer.sent).toHaveLength(0);
    expect(await pending(db)).toEqual([]);

    await ingest(apiKey, { fp: "fp-wanted" });
    await waitForEmails(1);
    expect(mailer.sent).toHaveLength(1);
  });

  it("no email while alerts are off, and switching them on does not send old issues", async () => {
    const { orgId, apiKey, db } = await newOrg();
    await ingest(apiKey, { fp: "fp-before" });
    await waitForEmails(1, 400);
    expect(mailer.sent).toHaveLength(0);
    expect(await pending(db)).toEqual([]); // cleared, not piling up

    // An issue marked by an older run but first seen before alerts were switched on.
    await db()
      .collection("issues")
      .updateOne(
        { fingerprint: "fp-before" },
        { $set: { alertPendingAt: new Date(Date.now() - 60_000).toISOString() } },
      );
    await setAlerts(orgId, { enabled: true, recipients: ["dev@example.com"] });
    const run = await app.inject({
      method: "POST",
      url: "/internal/alerts/run",
      headers: { authorization: `Bearer ${CRON}` },
    });
    expect(run.statusCode).toBe(200);
    expect(mailer.sent).toHaveLength(0);
    expect(await pending(db)).toEqual([]);
  });

  it("an error that only changed fingerprint (an SDK upgrade) is not alerted as new", async () => {
    const { orgId, apiKey } = await newOrg();
    await ingest(apiKey, { fp: "fp-old-sdk", message: "same error" });
    await setAlerts(orgId, { enabled: true, recipients: ["dev@example.com"] });
    await ingest(apiKey, { fp: "fp-new-sdk", message: "same error" });
    await waitForEmails(1, 400);
    expect(mailer.sent).toHaveLength(0);
  });

  it("the same message thrown from another place in the code is a new error", async () => {
    const { orgId, apiKey } = await newOrg();
    await ingest(apiKey, { fp: "fp-here", message: "same message", fn: "computeTotals" });
    await setAlerts(orgId, { enabled: true, recipients: ["dev@example.com"] });
    await ingest(apiKey, { fp: "fp-there", message: "same message", fn: "applyCoupon" });
    await waitForEmails(1);
    expect(mailer.sent).toHaveLength(1);
  });

  it("an error first seen in staging alerts when it reaches production", async () => {
    const { orgId, apiKey, db } = await newOrg();
    await setAlerts(orgId, {
      enabled: true,
      recipients: ["dev@example.com"],
      environments: ["production"],
    });
    await ingest(apiKey, { fp: "fp-travels", environment: "staging" });
    await waitForEmails(1, 400);
    expect(mailer.sent).toHaveLength(0);
    expect(await pending(db)).toEqual([]);

    await ingest(apiKey, { fp: "fp-travels", environment: "production" });
    await waitForEmails(1);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.email.subject).toContain("orders-api · staging, production");

    // Production again is nothing new.
    await ingest(apiKey, { fp: "fp-travels", environment: "production" });
    await waitForEmails(2, 300);
    expect(mailer.sent).toHaveLength(1);
  });

  it("past the hourly cap, new errors wait and go out together when it allows", async () => {
    const { orgId, apiKey, db } = await newOrg();
    await setAlerts(orgId, { enabled: true, recipients: ["dev@example.com"] });
    await ingest(apiKey, { fp: "fp-c1" });
    await waitForEmails(1);
    await ingest(apiKey, { fp: "fp-c2" });
    await waitForEmails(2);
    await ingest(apiKey, { fp: "fp-c3" });
    await ingest(apiKey, { fp: "fp-c4" });
    await waitForEmails(3, 400);
    expect(mailer.sent).toHaveLength(2); // the cap is 2 an hour
    expect((await pending(db)).sort()).toEqual(["fp-c3", "fp-c4"]);

    // An hour later (the sends are moved back), the scheduler sends what waited, in one email.
    const hourAgo = new Date(Date.now() - 61 * 60 * 1000).toISOString();
    await controlDb
      .getClient()
      .db("bugbuster_control")
      .collection("orgs")
      .updateOne({ orgId }, { $set: { "alertState.sentAt": [hourAgo, hourAgo] } });
    const run = await app.inject({
      method: "GET",
      url: "/internal/alerts/run",
      headers: { authorization: `Bearer ${CRON}` },
    });
    expect(run.json()).toMatchObject({ configured: true, emails: 1, alerted: 2, errors: 0 });
    expect(mailer.sent[2]!.email.subject).toBe("2 new errors in orders-api");
    expect(await pending(db)).toEqual([]);
  });

  it("a failed send keeps the issue pending and says why; the next run sends it", async () => {
    const { orgId, apiKey, db } = await newOrg();
    await setAlerts(orgId, { enabled: true, recipients: ["dev@example.com"] });
    mailer.failWith = new Error("Brevo refused the email (HTTP 401: Key not found)");
    await ingest(apiKey, { fp: "fp-fail" });
    await waitForEmails(1, 400);
    expect(await pending(db)).toEqual(["fp-fail"]);
    let org = (await admin("GET", "/admin/orgs"))
      .json()
      .orgs.find((o: { orgId: string }) => o.orgId === orgId);
    expect(org.alerts.lastError).toBe("Brevo refused the email (HTTP 401: Key not found)");

    mailer.failWith = undefined;
    expect((await notifier.runForOrg(orgId)).emails).toBe(1);
    expect(await pending(db)).toEqual([]);
    org = (await admin("GET", "/admin/orgs"))
      .json()
      .orgs.find((o: { orgId: string }) => o.orgId === orgId);
    expect(org.alerts.lastError).toBeUndefined();
  });

  it("two runs at once send one email", async () => {
    const { orgId, db } = await newOrg();
    await setAlerts(orgId, { enabled: true, recipients: ["dev@example.com"] });
    const now = new Date().toISOString();
    await db()
      .collection("issues")
      .insertOne({
        fingerprint: "fp-race",
        count: 1,
        userIdSet: [],
        endpointCounts: {},
        durationSamplesMs: [],
        releases: [],
        services: ["orders-api"],
        environments: ["production"],
        firstSeen: now,
        lastSeen: now,
        exemplarRefs: [],
        adjustedCount: 1,
        alertPendingAt: now,
      });
    const [a, b] = await Promise.all([notifier.runForOrg(orgId), notifier.runForOrg(orgId)]);
    expect(a.emails + b.emails).toBe(1);
    expect(mailer.sent).toHaveLength(1);
  });

  it("records each issue's environments, from its example events", async () => {
    const { apiKey } = await newOrg();
    await ingest(apiKey, { fp: "fp-env", environment: "staging" });
    const issues = (
      await app.inject({
        method: "GET",
        url: "/issues",
        headers: { authorization: `Bearer ${apiKey}` },
      })
    ).json().issues;
    expect(issues[0]).toMatchObject({ fingerprint: "fp-env", environments: ["staging"] });
  });
});

describe("test email", () => {
  it("goes to the saved recipients", async () => {
    const { orgId } = await newOrg();
    expect((await admin("POST", `/admin/orgs/${orgId}/alerts/test`)).statusCode).toBe(400);
    await setAlerts(orgId, {
      enabled: false,
      recipients: ["dev@example.com"],
      services: ["orders-api"],
    });
    const res = await admin("POST", `/admin/orgs/${orgId}/alerts/test`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sentTo: 1 });
    expect(mailer.sent[0]!.to).toEqual(["dev@example.com"]);
    expect(mailer.sent[0]!.email.subject).toBe(`BugBuster test email for Org ${orgCount}`);
    expect(mailer.sent[0]!.email.text).toContain("when orders-api reports an error");
  });

  it("passes Brevo's refusal on as a 502", async () => {
    const { orgId } = await newOrg();
    await setAlerts(orgId, { enabled: true, recipients: ["dev@example.com"] });
    mailer.failWith = new Error("Brevo refused the email (HTTP 400: sender not valid)");
    const res = await admin("POST", `/admin/orgs/${orgId}/alerts/test`);
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("Brevo refused the email (HTTP 400: sender not valid)");
  });
});

describe("cron route", () => {
  it("needs the secret", async () => {
    expect((await app.inject({ method: "GET", url: "/internal/alerts/run" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/internal/alerts/run",
          headers: { authorization: "Bearer wrong-secret-of-good-length" },
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe("a backend without email set up", () => {
  let plain: FastifyInstance;
  beforeAll(async () => {
    plain = buildServer(baseConfig(mongo.getUri()), controlDb);
    await plain.ready();
  });
  afterAll(async () => {
    await plain.close();
  });

  it("still saves settings, says email isn't set up, and has no cron route", async () => {
    const { orgId } = await newOrg();
    const asAdmin = (
      method: "GET" | "POST" | "PUT",
      url: string,
      payload?: Record<string, unknown>,
    ) =>
      plain.inject({
        method,
        url,
        headers: { authorization: `Bearer ${ADMIN}` },
        ...(payload ? { payload } : {}),
      });
    expect(
      (
        await asAdmin("PUT", `/admin/orgs/${orgId}/alerts`, {
          enabled: true,
          recipients: ["a@x.io"],
        })
      ).statusCode,
    ).toBe(200);
    expect((await asAdmin("GET", "/admin/orgs")).json().emailAlerts).toEqual({ configured: false });
    const test = await asAdmin("POST", `/admin/orgs/${orgId}/alerts/test`);
    expect(test.statusCode).toBe(409);
    expect(test.json().error).toContain("BUGBUSTER_BREVO_API_KEY");
    expect((await plain.inject({ method: "GET", url: "/internal/alerts/run" })).statusCode).toBe(
      404,
    );
  });
});
