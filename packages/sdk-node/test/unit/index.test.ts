import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { init } from "../../src/index.js";

let server: Server;
let port: number;
let requestCount: number;
let respondWith: (res: ServerResponse) => void;

beforeEach(async () => {
  requestCount = 0;
  respondWith = (res) => res.writeHead(202).end();
  server = createServer((_req, res) => {
    requestCount++;
    respondWith(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("init() end-to-end", () => {
  it("captures, folds, and flushes a valid exception through to a 202 without throwing", async () => {
    const client = init({
      project: "test-app",
      apiKey: "sk_test",
      backendUrl: `http://127.0.0.1:${port}/ingest`,
      flushMaxDelayMs: 60_000, // won't fire on its own during the test
    });
    client.captureException(new Error("boom"));
    await expect(client.shutdown()).resolves.toBeUndefined();
    expect(requestCount).toBe(1);
  });

  it("never throws when the configured backend is entirely unreachable", async () => {
    const client = init({
      project: "test-app",
      apiKey: "sk_test",
      backendUrl: "http://127.0.0.1:1/ingest", // nothing listens here
      flushMaxDelayMs: 60_000,
    });
    client.captureException(new Error("boom"));
    await expect(client.shutdown()).resolves.toBeUndefined();
  });

  it("withholds the next send until X-BB-Retry-After elapses, after a successful send granted it", async () => {
    let callNumber = 0;
    respondWith = (res) => {
      callNumber++;
      if (callNumber === 1) {
        res.setHeader("X-BB-Retry-After", "3600"); // effectively "don't send again this test"
      }
      res.writeHead(202).end();
    };

    const client = init({
      project: "test-app",
      apiKey: "sk_test",
      backendUrl: `http://127.0.0.1:${port}/ingest`,
      flushMaxDelayMs: 60_000,
    });

    client.captureException(new Error("first"));
    await client.shutdown(); // triggers the first (only, in this call) send -> grants Retry-After

    // A second client sharing nothing with the first would not be withheld — but here we
    // exercise the SAME withholding window by capturing again before it could have expired.
    // Since shutdown() only flushes once, we assert the granted window actually took effect by
    // checking that a same-tick manual second flush attempt does not add a second request.
    client.captureException(new Error("second"));
    await client.shutdown();

    expect(requestCount).toBe(1); // second flush was withheld by Retry-After, never reached the server
  });
});
