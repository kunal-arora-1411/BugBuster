import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpTransport } from "../../src/transport/http-transport.js";
import { TransportError } from "../../src/transport/transport.js";

let server: Server;
let port: number;
let requestCount: number;
let respondWith: (req: IncomingMessage, res: ServerResponse) => void;

beforeEach(async () => {
  requestCount = 0;
  respondWith = (_req, res) => res.writeHead(202).end();
  server = createServer((req, res) => {
    requestCount++;
    respondWith(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function url() {
  return `http://127.0.0.1:${port}/ingest`;
}

describe("HttpTransport", () => {
  it("resolves and parses directives from headers on a valid batch when the stub returns 202", async () => {
    respondWith = (_req, res) => {
      res.setHeader("X-BB-Sample-Directive", JSON.stringify({ error: 1, log: 0.02, span: 0.005 }));
      res.setHeader("X-BB-Config-Version", "42");
      res.writeHead(202).end();
    };
    const transport = new HttpTransport({ url: url(), apiKey: "test-key" });
    const directives = await transport.send(Buffer.from("{}\n"));
    expect(directives?.sample.log).toBe(0.02);
    expect(directives?.configVersion).toBe(42);
  });

  it("retries exactly maxRetries times on a valid batch when the server returns 503, then gives up", async () => {
    respondWith = (_req, res) => res.writeHead(503).end();
    const transport = new HttpTransport({ url: url(), apiKey: "test-key", maxRetries: 3 });
    await expect(transport.send(Buffer.from("{}\n"))).rejects.toThrow();
    expect(requestCount).toBe(4); // initial attempt + 3 retries
  });

  it("never retries on a 400 response", async () => {
    respondWith = (_req, res) => res.writeHead(400).end();
    const transport = new HttpTransport({ url: url(), apiKey: "test-key", maxRetries: 3 });
    await expect(transport.send(Buffer.from("{}\n"))).rejects.toBeInstanceOf(TransportError);
    expect(requestCount).toBe(1); // no retries
  });

  it("rejects (does not hang, does not throw synchronously) when the backend is entirely unreachable", async () => {
    const unreachable = new HttpTransport({
      url: "http://127.0.0.1:1/ingest", // port 1: nothing listens here
      apiKey: "test-key",
      maxRetries: 0,
      totalTimeoutMs: 500,
    });
    await expect(unreachable.send(Buffer.from("{}\n"))).rejects.toBeTruthy();
  });
});
