import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decodeEnvelopeItems,
  encodeEnvelope,
  type Envelope,
  type EnvelopeItem,
  type LogEntry,
  type LogLevel,
} from "@bugbusterhq/types";
import { UdsServer, type UdsServerOptions } from "../../src/uds-server.js";
import { AgentHttpClient } from "../../src/http-client.js";

function freshSocketPath(): string {
  const id = `bugbuster-logs-${process.pid}-${Math.random().toString(36).slice(2)}`;
  return platform === "win32" ? `\\\\.\\pipe\\${id}` : join(tmpdir(), `${id}.sock`);
}

function log(message: string, level: LogLevel = "info"): LogEntry {
  return {
    logId: `id-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    level,
    message,
    service: { name: "svc", version: "1.0.0", environment: "test" },
  };
}

const PRIORITY = { debug: 0, info: 1, warn: 3, error: 3 } as const;

function logEnvelope(...logs: LogEntry[]): Envelope {
  return {
    sentAt: new Date().toISOString(),
    sdkVersion: "0.0.0",
    items: logs.map((payload) => ({
      type: "log" as const,
      priority: PRIORITY[payload.level],
      payload,
    })),
  };
}

function foldEnvelope(fingerprint: string, count: number): Envelope {
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
          userIds: [],
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
let received: EnvelopeItem[][];

beforeEach(async () => {
  received = [];
  httpServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "zstd") body = zstdDecompressSync(body);
      received.push(decodeEnvelopeItems(body));
      res.writeHead(202).end();
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  httpPort = (httpServer.address() as { port: number }).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

async function withAgent(
  opts: Partial<UdsServerOptions>,
  body: (socketPath: string, server: UdsServer) => Promise<void>,
): Promise<void> {
  const socketPath = freshSocketPath();
  const httpClient = new AgentHttpClient({
    url: `http://127.0.0.1:${httpPort}/ingest`,
    apiKey: "k",
  });
  const server = new UdsServer({ socketPath, httpClient, flushIntervalMs: 60_000, ...opts });
  await server.start();
  try {
    await body(socketPath, server);
  } finally {
    await server.stop();
  }
}

function send(socketPath: string, envelope: Envelope): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath, () => socket.end(encodeEnvelope(envelope)));
    socket.on("close", () => resolve());
    socket.on("error", reject);
  });
}

const logsIn = (items: EnvelopeItem[][]) =>
  items.flat().filter((i): i is Extract<EnvelopeItem, { type: "log" }> => i.type === "log");

describe("UdsServer — log forwarding", () => {
  it("forwards log items from the SDK to the backend, a logs-only window included", async () => {
    await withAgent({}, async (socketPath, server) => {
      await send(socketPath, logEnvelope(log("hello"), log("world")));
      await server.flush();
      expect(received).toHaveLength(1);
      expect(logsIn(received).map((i) => i.payload.message)).toEqual(["hello", "world"]);
    });
  });

  it("does not fold logs across processes: identical lines from two services stay separate", async () => {
    await withAgent({}, async (socketPath, server) => {
      await send(socketPath, logEnvelope(log("user logged in")));
      await send(socketPath, logEnvelope(log("user logged in")));
      await server.flush();
      const forwarded = logsIn(received);
      expect(forwarded).toHaveLength(2);
      expect(new Set(forwarded.map((i) => i.payload.logId)).size).toBe(2);
    });
  });

  it("preserves each line's priority so the backend's shed ladder still works", async () => {
    await withAgent({}, async (socketPath, server) => {
      await send(socketPath, logEnvelope(log("d", "debug"), log("i", "info"), log("e", "error")));
      await server.flush();
      expect(logsIn(received).map((i) => i.priority)).toEqual([0, 1, 3]);
    });
  });

  it("still cross-process-folds errors while logs ride along in the same envelope", async () => {
    await withAgent({}, async (socketPath, server) => {
      await send(socketPath, foldEnvelope("fp_shared", 40));
      await send(socketPath, foldEnvelope("fp_shared", 60));
      await send(socketPath, logEnvelope(log("context line")));
      await server.flush();

      expect(received).toHaveLength(1);
      const folds = received[0]?.filter((i) => i.type === "fold") ?? [];
      expect(folds).toHaveLength(1);
      expect(folds[0]?.type === "fold" && folds[0].payload.count).toBe(100);
      expect(logsIn(received)).toHaveLength(1);
    });
  });

  it("splits a large window into bounded requests, preserving order, error path in the first", async () => {
    await withAgent({ maxBatchBytes: 2000 }, async (socketPath, server) => {
      await send(socketPath, foldEnvelope("fp_x", 5));
      const lines = Array.from({ length: 60 }, (_, i) => log(`line ${i} ${"x".repeat(80)}`));
      await send(socketPath, logEnvelope(...lines));
      await server.flush();

      expect(received.length).toBeGreaterThan(1);
      expect(logsIn(received).map((i) => i.payload.message.split(" ")[1])).toEqual(
        Array.from({ length: 60 }, (_, i) => String(i)),
      );
      expect(received[0]?.some((i) => i.type === "fold")).toBe(true);
      for (const later of received.slice(1)) {
        expect(later.some((i) => i.type === "fold")).toBe(false);
      }
    });
  });

  it("sheds chatter past the soft cap but keeps warn/error, and reports the drops upstream", async () => {
    await withAgent({ maxPendingLogs: 5 }, async (socketPath, server) => {
      await send(
        socketPath,
        logEnvelope(...Array.from({ length: 12 }, (_, i) => log(`info ${i}`, "info"))),
      );
      await send(socketPath, logEnvelope(log("important", "error"), log("also important", "warn")));
      await server.flush();

      const messages = logsIn(received).map((i) => i.payload.message);
      expect(messages.filter((m) => m.startsWith("info"))).toHaveLength(5);
      expect(messages).toContain("important");
      expect(messages).toContain("also important");

      const meta = received.flat().filter((i) => i.type === "meta");
      const dropped = meta.reduce(
        (n, m) => n + (m.type === "meta" ? m.payload.droppedBufferFull : 0),
        0,
      );
      expect(dropped).toBe(7); // 12 sent, 5 admitted
    });
  });

  it("a second flush after a shed window starts clean (no stale drop count, no stale lines)", async () => {
    await withAgent({ maxPendingLogs: 2 }, async (socketPath, server) => {
      await send(socketPath, logEnvelope(log("a"), log("b"), log("c"), log("d")));
      await server.flush();
      received.length = 0;

      await send(socketPath, logEnvelope(log("fresh")));
      await server.flush();
      expect(logsIn(received).map((i) => i.payload.message)).toEqual(["fresh"]);
      const dropped = received
        .flat()
        .reduce((n, i) => n + (i.type === "meta" ? i.payload.droppedBufferFull : 0), 0);
      expect(dropped).toBe(0);
    });
  });

  it("sends nothing when there is nothing pending", async () => {
    await withAgent({}, async (_socketPath, server) => {
      await server.flush();
      expect(received).toHaveLength(0);
    });
  });
});
