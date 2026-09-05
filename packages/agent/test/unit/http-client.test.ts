import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentHttpClient } from "../../src/http-client.js";
import { CircuitBreaker } from "../../src/circuit-breaker.js";

let server: Server;
let port: number;
let requestCount: number;

beforeEach(async () => {
  requestCount = 0;
  server = createServer((_req, res) => {
    requestCount++;
    res.writeHead(202).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("AgentHttpClient", () => {
  it("sends a valid batch successfully when the backend returns 202", async () => {
    const client = new AgentHttpClient({ url: `http://127.0.0.1:${port}/ingest`, apiKey: "k" });
    const result = await client.send(Buffer.from("payload"));
    expect(result.attempted).toBe(true);
    expect(requestCount).toBe(1);
  });

  it("fails instantly with zero network calls when the circuit breaker is OPEN", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 });
    breaker.onFailure(); // trips it open immediately (threshold 1)
    const client = new AgentHttpClient({
      url: `http://127.0.0.1:${port}/ingest`,
      apiKey: "k",
      circuitBreaker: breaker,
    });
    const result = await client.send(Buffer.from("payload"));
    expect(result.attempted).toBe(false);
    expect(requestCount).toBe(0); // the point of OPEN: no network call was ever made
  });
});
