import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import type {
  BugBusterEvent,
  DropCounters,
  EnvelopeItem,
  FoldDelta,
  Priority,
} from "@bugbuster/types";
import { decodeEnvelopeItems, encodeEnvelope } from "@bugbuster/types";
import { mergeFoldDeltas } from "./merge-fold-deltas.js";
import { buildOutgoingEnvelope, type PrioritizedExemplar } from "./build-outgoing-envelope.js";
import type { AgentHttpClient } from "./http-client.js";
import type { DiskSpool } from "./spool.js";

const AGENT_VERSION = "0.0.0";

export interface UdsServerOptions {
  socketPath: string;
  httpClient: AgentHttpClient;
  spool?: DiskSpool;
  flushIntervalMs?: number;
}

/**
 * The Agent's listener: every SDK on this host connects here over UDS. Cross-process folding
 * (ingest-pipeline.md §6.2) happens by simply accumulating fold deltas from every connection into
 * one shared pending set and merging them on the next flush — the Agent doesn't need to know how
 * many services are connected, only that they all land in the same merge.
 */
export class UdsServer {
  private readonly server: Server;
  private pendingFolds: { priority: Priority; payload: FoldDelta }[] = [];
  private pendingExemplars: PrioritizedExemplar[] = [];
  private pendingMeta: DropCounters[] = [];
  private timer?: NodeJS.Timeout;

  constructor(private readonly options: UdsServerOptions) {
    this.server = createServer((socket) => this.handleConnection(socket));
    this.server.on("error", () => {
      // A listener-level error (e.g. a stray connection reset) must not crash the Agent process.
    });
  }

  private handleConnection(socket: Socket): void {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => this.ingestItems(decodeEnvelopeItems(Buffer.concat(chunks))));
    socket.on("error", () => {
      // One misbehaving client connection must not affect any other client or the Agent itself.
    });
  }

  private ingestItems(items: EnvelopeItem[]): void {
    for (const item of items) {
      if (item.type === "fold") {
        this.pendingFolds.push({ priority: item.priority, payload: item.payload });
      } else if (item.type === "exemplar") {
        this.pendingExemplars.push({
          priority: item.priority,
          payload: item.payload as BugBusterEvent,
        });
      } else if (item.type === "meta") {
        this.pendingMeta.push(item.payload);
      }
    }
  }

  async start(): Promise<void> {
    if (existsSync(this.options.socketPath)) {
      unlinkSync(this.options.socketPath); // stale socket file left by a previous crashed run
    }
    await new Promise<void>((resolve) => this.server.listen(this.options.socketPath, resolve));
    const interval = this.options.flushIntervalMs ?? 5000;
    this.timer = setInterval(() => void this.flush(), interval);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  async flush(): Promise<void> {
    // Replay anything spooled from a previous failed send first, so retried batches go out
    // before newer data — best-effort ordering, not a strict guarantee at pilot scale.
    if (this.options.spool) {
      const spooled = await this.options.spool.drainAll();
      for (const payload of spooled) {
        try {
          await this.options.httpClient.send(payload);
        } catch {
          await this.options.spool.write(payload); // still down — re-spool and try again later
        }
      }
    }

    if (this.pendingFolds.length === 0 && this.pendingExemplars.length === 0) return;

    const foldPriorityByFingerprint = new Map<string, Priority>();
    for (const { priority, payload } of this.pendingFolds) {
      const current = foldPriorityByFingerprint.get(payload.fingerprint);
      if (current === undefined || priority > current) {
        foldPriorityByFingerprint.set(payload.fingerprint, priority);
      }
    }

    const merged = mergeFoldDeltas(this.pendingFolds.map((f) => f.payload));
    const envelope = buildOutgoingEnvelope({
      mergedFolds: merged,
      foldPriorityByFingerprint,
      exemplars: this.pendingExemplars,
      meta: this.pendingMeta,
      agentVersion: AGENT_VERSION,
    });
    const payload = encodeEnvelope(envelope);

    this.pendingFolds = [];
    this.pendingExemplars = [];
    this.pendingMeta = [];

    try {
      await this.options.httpClient.send(payload);
    } catch {
      if (this.options.spool) await this.options.spool.write(payload);
      // no spool configured: batch is lost, matching the SDK's own documented behavior when its
      // transport fails — a counted drop, not a crash.
    }
  }
}
