import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { LogEntry } from "@bugbusterhq/types";
import { ControlDb, buildServer } from "@bugbusterhq/backend";
import { AgentHttpClient, UdsServer } from "@bugbusterhq/agent";
import { init, type BugBusterClient } from "@bugbusterhq/sdk-node";
import type { BugBusterExpressIntegration } from "@bugbusterhq/sdk-node";
import { buildApp } from "../src/app.js";

/**
 * End-to-end proof of the LOG path, every hop real: a real Express app instrumented with the SDK's
 * Express integration, receiving real HTTP requests; the SDK handing batches to a real Agent over a
 * real Unix domain socket; the Agent forwarding zstd-compressed over real HTTP to a real backend;
 * stored in a real MongoDB; read back through the real Query API.
 *
 * (The same philosophy as full-pipeline.test.ts for errors: each package's own tests can pass while
 * the seams between them are broken, so this is the test that asserts the seams.)
 */

function freshSocketPath(): string {
  const id = `bugbuster-logs-e2e-${process.pid}-${Math.random().toString(36).slice(2)}`;
  return platform === "win32" ? `\\\\.\\pipe\\${id}` : join(tmpdir(), `${id}.sock`);
}

const ORG = {
  orgId: "org_logs",
  name: "Logs E2E",
  dbName: "bugbuster_org_logs_e2e",
  apiKey: "logs-key",
};

let mongo: MongoMemoryServer;
let controlDb: ControlDb;
let backend: FastifyInstance;
let agent: UdsServer;
let sdk: BugBusterClient;
let appServer: Server;
let appPort: number;
let restoreConsole: () => void;
let bb: BugBusterExpressIntegration;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  controlDb = new ControlDb(mongo.getUri());
  await controlDb.connect();
  await controlDb.createOrg(ORG);

  backend = buildServer(
    { port: 0, controlDbUri: mongo.getUri(), ingestMaxBodyBytes: 1024 * 1024, logRetentionDays: 7 },
    controlDb,
  );
  await backend.listen({ port: 0, host: "127.0.0.1" });
  const backendPort = (backend.server.address() as { port: number }).port;

  const socketPath = freshSocketPath();
  agent = new UdsServer({
    socketPath,
    httpClient: new AgentHttpClient({
      url: `http://127.0.0.1:${backendPort}/ingest`,
      apiKey: ORG.apiKey,
    }),
    flushIntervalMs: 60_000, // flushed manually below
  });
  await agent.start();

  sdk = init({
    project: "demo-app",
    apiKey: ORG.apiKey,
    environment: "e2e",
    release: "9.9.9",
    agentSocketPath: socketPath,
    flushMaxDelayMs: 60_000, // flushed manually below
  });

  const built = buildApp(sdk);
  bb = built.bb;
  const app = built.app;
  restoreConsole = bb.instrumentConsole({ logs: true });
  appServer = createServer(app);
  await new Promise<void>((resolve) => appServer.listen(0, "127.0.0.1", resolve));
  appPort = (appServer.address() as { port: number }).port;
}, 120_000);

afterAll(async () => {
  restoreConsole?.();
  await new Promise<void>((resolve) => appServer.close(() => resolve()));
  await agent.stop();
  await backend.close();
  await controlDb.close();
  await mongo.stop();
});

beforeEach(async () => {
  await controlDb.getClient().db(ORG.dbName).collection("logs").deleteMany({});
  await controlDb.getClient().db(ORG.dbName).collection("issues").deleteMany({});
  await controlDb.getClient().db(ORG.dbName).collection("events").deleteMany({});
});

/** SDK -> Agent (UDS), then Agent -> backend (HTTP): the two manual flushes of the pipeline. */
async function flushPipeline(): Promise<void> {
  await sdk.shutdown();
  await agent.flush();
}

const hit = (path: string) => fetch(`http://127.0.0.1:${appPort}${path}`);

async function api<T>(path: string): Promise<T> {
  const res = await backend.inject({
    method: "GET",
    url: path,
    headers: { authorization: `Bearer ${ORG.apiKey}` },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as T;
}

const readLogs = async (qs = "") => (await api<{ logs: LogEntry[] }>(`/logs${qs}`)).logs;

describe("logs: Express app -> SDK -> Agent (UDS) -> backend -> MongoDB -> Query API", () => {
  it("a request produces a structured access-log line with method, path, status, duration, service", async () => {
    await hit("/orders/42");
    await flushPipeline();

    const access = (await readLogs()).find((l) => l.message.startsWith("GET /orders/42"));
    expect(access).toBeDefined();
    expect(access).toMatchObject({
      level: "info",
      fields: { method: "GET", path: "/orders/42", status: 200 },
      service: { name: "demo-app", version: "9.9.9", environment: "e2e" },
    });
    expect(typeof access?.fields?.durationMs).toBe("number");
  });

  it("an application log inside a handler shares one trace id with that request's access line", async () => {
    await hit("/orders/7");
    await flushPipeline();

    const lines = await readLogs();
    const app = lines.find((l) => l.message === "order lookup");
    const access = lines.find((l) => l.message.startsWith("GET /orders/7"));
    expect(app?.fields).toEqual({ orderId: "7", source: "demo" });
    expect(app?.trace?.traceId).toBeTruthy();
    expect(app?.trace?.traceId).toBe(access?.trace?.traceId);

    // ...and that trace id alone retrieves exactly this request's lines
    const byTrace = await readLogs(`?traceId=${app?.trace?.traceId}`);
    expect(byTrace.map((l) => l.message).sort()).toEqual(
      [
        "GET /orders/7 200 ".concat(String(access?.fields?.durationMs), "ms"),
        "order lookup",
      ].sort(),
    );
  });

  it("THE LOOP: an error's issue example links to every log line that same request wrote", async () => {
    const res = await hit("/checkout");
    expect(res.status).toBe(502);
    await flushPipeline();

    // 1. a developer opens the issue and its example (the existing error workflow)
    const { issues } = await api<{ issues: { fingerprint: string }[] }>("/issues");
    expect(issues).toHaveLength(1);
    const { exemplars } = await api<{
      exemplars: { trace: { traceId: string }; error?: { message: string } }[];
    }>(`/issues/${issues[0]?.fingerprint}/exemplars`);
    const traceId = exemplars[0]?.trace.traceId;
    expect(exemplars[0]?.error?.message).toContain("payment gateway timed out");
    expect(traceId).toBeTruthy();

    // 2. clicks "View logs for this request": the example's trace id retrieves the request's story
    const story = await readLogs(`?traceId=${encodeURIComponent(traceId!)}`);
    const summary = story.map((l) => `${l.level}: ${l.message.replace(/ [\d.]+ms$/, "")}`);
    expect(summary).toContain("info: checkout started");
    expect(summary).toContain("error: payment failed");
    expect(summary).toContain("error: GET /checkout 502"); // 5xx access line is error-level
    expect(story.every((l) => l.trace?.traceId === traceId)).toBe(true);
  });

  it("does not fold logs: the same request five times is five access lines, five app lines", async () => {
    for (let i = 0; i < 5; i++) await hit("/orders/1");
    await flushPipeline();
    const lines = await readLogs();
    expect(lines.filter((l) => l.message === "order lookup")).toHaveLength(5);
    expect(lines.filter((l) => l.message.startsWith("GET /orders/1 "))).toHaveLength(5);
    // and each is a distinct stored record
    expect(new Set(lines.map((l) => l.logId)).size).toBe(lines.length);
  });

  it("returns lines written back-to-back in the same millisecond in reverse write order (newest first)", async () => {
    for (let i = 0; i < 30; i++) sdk.log.info(`burst ${i}`);
    await flushPipeline();
    const burst = (await readLogs("?q=burst")).map((l) => Number(l.message.split(" ")[1]));
    expect(burst).toEqual(Array.from({ length: 30 }, (_, i) => 29 - i));
  });

  it("skips ignorePaths: health probes leave no log lines", async () => {
    await hit("/healthz");
    await hit("/healthz");
    await hit("/orders/3");
    await flushPipeline();
    const messages = (await readLogs()).map((l) => l.message);
    expect(messages.some((m) => m.includes("/healthz"))).toBe(false);
    expect(messages.some((m) => m.startsWith("GET /orders/3"))).toBe(true);
  });

  it("never stores a query string, and redacts sensitive field keys before they leave the process", async () => {
    await hit("/orders/9?token=SUPERSECRET&email=bob@example.com");
    await hit("/checkout"); // logs { password: ... } in its error line
    await flushPipeline();

    // scan the RAW stored documents, not just the API's view of them
    const raw = JSON.stringify(
      await controlDb.getClient().db(ORG.dbName).collection("logs").find({}).toArray(),
    );
    expect(raw).not.toContain("SUPERSECRET");
    expect(raw).not.toContain("bob@example.com");
    expect(raw).not.toContain("not-a-real-password");
    const paymentFailed = (await readLogs("?q=payment%20failed"))[0];
    expect(paymentFailed?.fields?.password).toBe("[redacted]");
  });

  it("with console capture on, console.log becomes a log line AND still prints", async () => {
    // Put a recording stand-in where the "original" console.log lives, then hook on top of it.
    // (Spying on process.stdout instead would not work under vitest, which replaces console.log
    // with its own implementation that never touches stdout.)
    restoreConsole();
    const printed: unknown[][] = [];
    const saved = console.log;
    console.log = (...args: unknown[]) => void printed.push(args);
    const restoreHook = bb.instrumentConsole({ logs: true });
    try {
      console.log("cache warmed: %d keys", 128);
    } finally {
      restoreHook();
      console.log = saved;
      restoreConsole = bb.instrumentConsole({ logs: true });
    }
    await flushPipeline();

    expect(printed).toEqual([["cache warmed: %d keys", 128]]); // original called, args untouched
    const line = (await readLogs("?q=cache%20warmed"))[0];
    expect(line).toMatchObject({ level: "info", message: "cache warmed: 128 keys" });
  });

  it("filters work against real pipeline data: level, service, search", async () => {
    await hit("/orders/5");
    await hit("/checkout");
    await flushPipeline();

    const errors = await readLogs("?level=error");
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.every((l) => l.level === "error")).toBe(true);
    expect((await readLogs("?service=demo-app&q=order%20lookup")).map((l) => l.message)).toEqual([
      "order lookup",
    ]);
    expect(await readLogs("?service=some-other-service")).toEqual([]);
    const facets = await api<{ services: string[]; environments: string[] }>("/logs/facets");
    expect(facets).toEqual({ services: ["demo-app"], environments: ["e2e"] });
  });

  it("error path is unharmed: grouped errors still fold alongside logs", async () => {
    await hit("/throw");
    await hit("/throw");
    await flushPipeline();
    const { issues } = await api<{ issues: { count: number }[] }>("/issues");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues.reduce((n, i) => n + i.count, 0)).toBeGreaterThanOrEqual(2);
  });
});
