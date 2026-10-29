import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import type {
  BugBusterEvent,
  DropCounters,
  EnvelopeItem,
  FoldDelta,
  Priority,
} from "@bugbusterhq/types";
import { decodeEnvelopeItems, encodeEnvelope, splitIntoBatches } from "@bugbusterhq/types";
import { mergeFoldDeltas } from "./merge-fold-deltas.js";
import {
  buildOutgoingEnvelope,
  type PrioritizedExemplar,
  type PrioritizedLog,
} from "./build-outgoing-envelope.js";
import type { AgentHttpClient } from "./http-client.js";
import type { DiskSpool } from "./spool.js";

const AGENT_VERSION = "0.0.0";

// Logs are the first item type whose volume is not bounded by fingerprint cardinality, so the
// Agent — a long-lived daemon every service on the host funnels through — must bound them itself.
const DEFAULT_MAX_PENDING_LOGS = 50_000;
// The line count alone does not bound memory: one line can carry an 8K-char message plus ~16 KB of
// fields, so 100k lines could be gigabytes. The byte cap is what actually protects the daemon.
const DEFAULT_MAX_PENDING_LOG_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_BATCH_BYTES = 512 * 1024; // matches the SDK's flushMaxBatchBytes default
// Priority >= this is warn/error (or higher): kept past the soft cap, up to HARD_CAP_FACTOR x.
const KEEP_PRIORITY = 3;
const HARD_CAP_FACTOR = 2;

export interface UdsServerOptions {
  socketPath: string;
  httpClient: AgentHttpClient;
  spool?: DiskSpool;
  flushIntervalMs?: number;
  /**
   * Soft cap on log lines held between flushes (default 50,000). Past it, debug/info lines are
   * shed first; warn/error lines are kept until twice the cap. Every shed line is counted into the
   * drop counters sent upstream — never silently lost.
   */
  maxPendingLogs?: number;
  /**
   * Soft cap on the serialized bytes of log lines held between flushes (default 64 MB), with the
   * same shed ladder as `maxPendingLogs`: warn/error lines are kept up to twice the cap. Whichever
   * cap is reached first applies.
   */
  maxPendingLogBytes?: number;
  /** Max serialized size of log lines per outbound request (default 512 KB, pre-compression). */
  maxBatchBytes?: number;
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
  private pendingLogs: PrioritizedLog[] = [];
  private pendingLogBytes = 0;
  private droppedLogs = 0;
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
      } else if (item.type === "log") {
        this.acceptLog({ priority: item.priority, payload: item.payload });
      } else if (item.type === "meta") {
        this.pendingMeta.push(item.payload);
      }
    }
  }

  /**
   * Priority-aware admission (the shed ladder, ingest-pipeline.md §8.2, applied at the Agent):
   * under a flood, chatter (debug 0, info 1) is refused once the soft cap is hit, while warn/error
   * (priority 3) are still admitted up to a hard cap. Refusals are counted, not hidden.
   */
  private acceptLog(log: PrioritizedLog): void {
    const factor = log.priority >= KEEP_PRIORITY ? HARD_CAP_FACTOR : 1;
    const countCap = (this.options.maxPendingLogs ?? DEFAULT_MAX_PENDING_LOGS) * factor;
    const byteCap = (this.options.maxPendingLogBytes ?? DEFAULT_MAX_PENDING_LOG_BYTES) * factor;
    const bytes = Buffer.byteLength(JSON.stringify(log.payload), "utf8");
    if (this.pendingLogs.length >= countCap || this.pendingLogBytes + bytes > byteCap) {
      this.droppedLogs++;
      return;
    }
    this.pendingLogs.push(log);
    this.pendingLogBytes += bytes;
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

    if (
      this.pendingFolds.length === 0 &&
      this.pendingExemplars.length === 0 &&
      this.pendingLogs.length === 0 &&
      this.droppedLogs === 0
    ) {
      return;
    }

    const foldPriorityByFingerprint = new Map<string, Priority>();
    for (const { priority, payload } of this.pendingFolds) {
      const current = foldPriorityByFingerprint.get(payload.fingerprint);
      if (current === undefined || priority > current) {
        foldPriorityByFingerprint.set(payload.fingerprint, priority);
      }
    }

    const merged = mergeFoldDeltas(this.pendingFolds.map((f) => f.payload));

    // Report shed log lines upstream in the same drop-counter channel the SDK uses.
    const meta = [...this.pendingMeta];
    if (this.droppedLogs > 0) {
      meta.push({
        droppedBufferFull: this.droppedLogs,
        droppedQuota: 0,
        sampledOut: 0,
        bufferHighWaterBytes: 0,
        selfCpuPct: 0,
        configVersion: 0,
      });
    }

    // Bound every outbound POST: the backend rejects an over-limit body whole (413). The error
    // path (folds/exemplars/meta) rides in the first envelope with the first batch of logs.
    const [firstLogs = [], ...remainingLogBatches] = splitIntoBatches(
      this.pendingLogs,
      this.options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES,
    );

    const payloads: Buffer[] = [
      encodeEnvelope(
        buildOutgoingEnvelope({
          mergedFolds: merged,
          foldPriorityByFingerprint,
          exemplars: this.pendingExemplars,
          meta,
          agentVersion: AGENT_VERSION,
          logs: firstLogs,
        }),
      ),
      ...remainingLogBatches.map((batch) =>
        encodeEnvelope(
          buildOutgoingEnvelope({
            mergedFolds: [],
            foldPriorityByFingerprint: new Map(),
            exemplars: [],
            meta: [],
            agentVersion: AGENT_VERSION,
            logs: batch,
          }),
        ),
      ),
    ];

    this.pendingFolds = [];
    this.pendingExemplars = [];
    this.pendingMeta = [];
    this.pendingLogs = [];
    this.pendingLogBytes = 0;
    this.droppedLogs = 0;

    for (const payload of payloads) {
      try {
        await this.options.httpClient.send(payload);
      } catch {
        if (this.options.spool) await this.options.spool.write(payload);
        // no spool configured: batch is lost, matching the SDK's own documented behavior when its
        // transport fails — a counted drop, not a crash.
      }
    }
  }
}
