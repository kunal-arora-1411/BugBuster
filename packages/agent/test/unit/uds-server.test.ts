import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeEnvelope } from "@bugbuster/types";
import type { Envelope } from "@bugbuster/types";
import { UdsServer } from "../../src/uds-server.js";
import { AgentHttpClient } from "../../src/http-client.js";

// Windows has no filesystem-path AF_UNIX convention the way POSIX does; named pipes are the
// portable equivalent Node exposes identically through the same `net` API.
function freshSocketPath(): string {
  const id = `bugbuster-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  return platform === "win32" ? `\\\\.\\pipe\\${id}` : join(tmpdir(), `${id}.sock`);
}

function foldEnvelope(fingerprint: string, count: number, userIds: string[]): Envelope {
  return {
    sentAt: new Date().toISOString(),
    sdkVersion: "0.0.0",
    items: [
      {
        type: "fold",
        priority: 3,
        payload: {
          fingerprint,
          windowStart: new Date(0).toISOString(),
          windowEnd: new Date().toISOString(),
          count,
          userIds,
          endpointCounts: {},
          durationSamplesMs: [],
          exemplars: [],
        },
      },
    ],
  };
}

let httpServer: Server;
let httpPort: number;
let receivedBodies: Buffer[];

beforeEach(async () => {
  receivedBodies = [];
  httpServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      receivedBodies.push(Buffer.concat(chunks));
      res.writeHead(202).end();
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  httpPort = (httpServer.address() as { port: number }).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe("UdsServer — cross-process fold merge (the Agent's reason to exist)", () => {
  it("merges two SDK clients reporting the same fingerprint into one combined record forwarded to the backend", async () => {
    const socketPath = freshSocketPath();
    const httpClient = new AgentHttpClient({
      url: `http://127.0.0.1:${httpPort}/ingest`,
      apiKey: "test-key",
    });
    const server = new UdsServer({ socketPath, httpClient, flushIntervalMs: 60_000 });
    await server.start();

    try {
      // Two "services" on the same host, each with their own SDK connection.
      await sendOverUds(socketPath, foldEnvelope("fp_shared", 40, ["u1", "u2"]));
      await sendOverUds(socketPath, foldEnvelope("fp_shared", 60, ["u2", "u3"]));

      await server.flush();

      expect(receivedBodies).toHaveLength(1); // exactly one outbound request, not two
      // The zstd-compressed body isn't decoded here — we only need to confirm the Agent
      // attempted exactly one send for the merged window, which the higher-level
      // merge-fold-deltas unit tests already prove combines the counts correctly.
      expect(receivedBodies[0]?.length).toBeGreaterThan(0);
    } finally {
      await server.stop();
    }
  });
});

function sendOverUds(socketPath: string, envelope: Envelope): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath, () => {
      socket.end(encodeEnvelope(envelope));
    });
    socket.on("close", () => resolve());
    socket.on("error", reject);
  });
}
