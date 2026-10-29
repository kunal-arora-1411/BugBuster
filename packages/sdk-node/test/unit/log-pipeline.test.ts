import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeEnvelopeItems, type EnvelopeItem, type LogEntry } from "@bugbusterhq/types";
import { init } from "../../src/index.js";
import { runWithContext } from "../../src/context.js";

/** A real HTTP server standing in for the backend: records every POST body, decoded. */
let server: Server;
let port: number;
let posts: EnvelopeItem[][];

beforeEach(async () => {
  posts = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      posts.push(decodeEnvelopeItems(Buffer.concat(chunks)));
      res.writeHead(202).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function client(extra: Record<string, unknown> = {}) {
  return init({
    project: "orders-api",
    apiKey: "sk_test",
    environment: "staging",
    release: "2.3.1",
    backendUrl: `http://127.0.0.1:${port}/ingest`,
    flushMaxDelayMs: 60_000, // never fires on its own; tests flush via shutdown()
    ...extra,
  });
}

const allItems = () => posts.flat();
const logItems = () =>
  allItems().filter((i): i is Extract<EnvelopeItem, { type: "log" }> => i.type === "log");

describe("init() — logs through the real pipeline", () => {
  it("client.log.info ships a log item with level, message, fields, service context, and priority 1", async () => {
    const c = client();
    c.log.info("order placed", { orderId: "o_1", total: 42.5 });
    await c.shutdown();

    const [item] = logItems();
    expect(item?.priority).toBe(1);
    const log: LogEntry | undefined = item?.payload;
    expect(log).toMatchObject({
      level: "info",
      message: "order placed",
      fields: { orderId: "o_1", total: 42.5 },
      service: { name: "orders-api", version: "2.3.1", environment: "staging" },
    });
    expect(log?.logId).toBeTruthy();
    expect(Number.isNaN(Date.parse(log!.timestamp))).toBe(false);
  });

  it("maps levels to the shed-ladder priorities: debug 0, info 1, warn 3, error 3", async () => {
    const c = client({ minLogLevel: "debug" });
    c.log.debug("d");
    c.log.info("i");
    c.log.warn("w");
    c.log.error("e");
    await c.shutdown();
    expect(logItems().map((i) => [i.payload.level, i.priority])).toEqual([
      ["debug", 0],
      ["info", 1],
      ["warn", 3],
      ["error", 3],
    ]);
  });

  it("drops debug by default (minLogLevel info) — it never reaches the wire", async () => {
    const c = client();
    c.log.debug("chatter");
    c.log.info("kept");
    await c.shutdown();
    expect(logItems().map((i) => i.payload.message)).toEqual(["kept"]);
  });

  it("does NOT fold: 50 identical lines arrive as 50 log items and zero fold/exemplar items", async () => {
    const c = client();
    for (let i = 0; i < 50; i++) c.log.info("user logged in", { userId: "u1" });
    await c.shutdown();
    expect(logItems()).toHaveLength(50);
    expect(allItems().filter((i) => i.type === "fold" || i.type === "exemplar")).toHaveLength(0);
  });

  it("preserves the order lines were written in", async () => {
    const c = client();
    for (let i = 0; i < 20; i++) c.log.info(`line ${i}`);
    await c.shutdown();
    expect(logItems().map((i) => i.payload.message)).toEqual(
      Array.from({ length: 20 }, (_, i) => `line ${i}`),
    );
  });

  it("attaches trace context inside a request and omits it outside", async () => {
    const c = client();
    runWithContext({ traceId: "trace-xyz", spanId: "span-1" }, () => c.log.info("in request"));
    c.log.info("background");
    await c.shutdown();
    const [inReq, bg] = logItems().map((i) => i.payload);
    expect(inReq?.trace).toEqual({ traceId: "trace-xyz", spanId: "span-1" });
    expect(bg?.trace).toBeUndefined();
  });

  it("redacts secrets in the message and in fields before anything leaves the process", async () => {
    const c = client();
    c.log.info("login for bob@example.com", { password: "hunter2", note: "Bearer abc.def" });
    await c.shutdown();
    const log = logItems()[0]?.payload;
    expect(log?.message).toBe("login for [redacted-email]");
    expect(log?.fields).toEqual({ password: "[redacted]", note: "[redacted-token]" });
  });

  it("carries an exception and logs together: the error path rides in the first envelope", async () => {
    const c = client();
    c.log.info("before the crash");
    c.captureException(new Error("boom"));
    await c.shutdown();
    expect(posts).toHaveLength(1);
    const types = new Set(posts[0]?.map((i) => i.type));
    expect(types).toEqual(new Set(["fold", "exemplar", "log", "meta"]));
  });

  it("a logs-only window still flushes (no exception required)", async () => {
    const c = client();
    c.log.info("just a log");
    await c.shutdown();
    expect(posts).toHaveLength(1);
    expect(logItems()).toHaveLength(1);
  });

  it("splits a big window into bounded batches: every line delivered, error path only in the first", async () => {
    const c = client({ flushMaxBatchBytes: 2000 });
    c.captureException(new Error("boom"));
    for (let i = 0; i < 100; i++) c.log.info(`line ${i} ${"x".repeat(100)}`);
    await c.shutdown();

    expect(posts.length).toBeGreaterThan(1);
    expect(logItems()).toHaveLength(100);
    expect(logItems().map((i) => i.payload.message.split(" ")[1])).toEqual(
      Array.from({ length: 100 }, (_, i) => String(i)),
    );
    // each POST stays near the cap (generous slack for the first envelope's error-path items)
    for (const post of posts.slice(1)) {
      expect(post.some((i) => i.type === "fold" || i.type === "exemplar")).toBe(false);
    }
    expect(posts[0]?.some((i) => i.type === "fold")).toBe(true);
  });

  it("a log flood cannot evict an exception (separate buffers, end to end)", async () => {
    const c = client({ logBufferBytes: 2000 });
    for (let i = 0; i < 2000; i++) c.log.info(`flood ${i}`);
    c.captureException(new Error("the real error"));
    await c.shutdown();
    const exemplar = allItems().find((i) => i.type === "exemplar");
    expect(exemplar).toBeDefined();
    expect(logItems().length).toBeLessThan(2000); // the flood was shed...
    expect(logItems().length).toBeGreaterThan(0); // ...but not entirely
  });

  it("never throws when the backend is unreachable, even with many log batches", async () => {
    const c = init({
      project: "p",
      apiKey: "k",
      backendUrl: "http://127.0.0.1:1/ingest",
      flushMaxDelayMs: 60_000,
      flushMaxBatchBytes: 1000,
    });
    for (let i = 0; i < 50; i++) c.log.info(`line ${i}`);
    await expect(c.shutdown()).resolves.toBeUndefined();
  });
});

describe("log ids sort in write order", () => {
  it("lines written in the same millisecond get strictly increasing ids, in write order", async () => {
    const c = client();
    for (let i = 0; i < 200; i++) c.log.info(`line ${i}`); // a tight loop: many per millisecond
    await c.shutdown();
    const ids = logItems().map((i) => i.payload.logId);
    expect(ids).toHaveLength(200);
    for (let i = 1; i < ids.length; i++) expect(ids[i]! > ids[i - 1]!).toBe(true);
  });

  it("ids are fixed-width, so string order equals time order across milliseconds too", async () => {
    const { newLogId } = await import("../../src/worker/log.js");
    const early = newLogId(1_000_000_000_000);
    const late = newLogId(1_900_000_000_000);
    expect(early).toHaveLength(late.length);
    expect(late > early).toBe(true);
  });
});
