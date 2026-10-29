import type { Envelope, LogEntry, ServiceContext } from "@bugbusterhq/types";
import { SdkConfigSchema, type SdkConfig } from "@bugbusterhq/types";
import { RingBuffer } from "./ring-buffer.js";
import { createSampler } from "./sampler.js";
import { createDropCounters } from "./drop-counters.js";
import { createCaptureEngine, type CaptureEngine } from "./capture.js";
import type { RawCapture } from "./raw-capture.js";
import { FoldTable } from "./worker/fold.js";
import { processCapture } from "./worker/pipeline.js";
import { buildLogEntry } from "./worker/log.js";
import { buildEnvelope, encodeEnvelope, splitLogsIntoBatches } from "./worker/serialize.js";
import { createLogApi, type LogApi } from "./logger.js";
import { HttpTransport } from "./transport/http-transport.js";
import { isAgentSocketAvailable, UdsTransport } from "./transport/uds-transport.js";
import type { Transport } from "./transport/transport.js";
import { SuppressionState, applyDirectives } from "./directives.js";

export type { CaptureEngine } from "./capture.js";
export { RingBuffer } from "./ring-buffer.js";
export { runWithContext, getCurrentContext, type BugBusterContext } from "./context.js";
export { FoldTable } from "./worker/fold.js";
export { computeFingerprint, computeCoarsenedFingerprint } from "./worker/fingerprint.js";
export { HttpTransport } from "./transport/http-transport.js";
export { UdsTransport, isAgentSocketAvailable } from "./transport/uds-transport.js";
export type { Transport } from "./transport/transport.js";
export {
  createExpressIntegration,
  type BugBusterExpressIntegration,
  type ExpressIntegrationOptions,
  type ExpressRequestLike,
} from "./integrations/express.js";
export { createLogApi, type LogApi, type LogFields } from "./logger.js";
export { createLogStream, type LogStreamOptions } from "./integrations/log-stream.js";

const SDK_VERSION = "0.0.0";

export interface BugBusterClient extends CaptureEngine {
  /**
   * `client.log.info("order placed", { orderId })` — application logs, stored line-by-line and
   * searchable in the dashboard's Logs view. Sugar over `captureLog`.
   */
  log: LogApi;
  /** Forces an immediate flush of everything currently held, bounded by shutdownFlushTimeoutMs. */
  shutdown(): Promise<void>;
}

export function init(rawConfig: unknown): BugBusterClient {
  const config: SdkConfig = SdkConfigSchema.parse(rawConfig);

  const ring = new RingBuffer<RawCapture>(config.ringBufferBytes);
  // Logs get their own buffer: they are far more frequent than exceptions, and sharing one ring
  // would let a burst of `info` lines evict the next real exception (see CaptureEngineDeps.logRing).
  const logRing = new RingBuffer<RawCapture>(config.logBufferBytes);
  const sampler = createSampler({ error: 1, log: 1, span: 1 });
  const counters = createDropCounters();
  const foldTable = new FoldTable(config.maxLiveFingerprints);
  const seenFingerprints = new Set<string>();
  const suppression = new SuppressionState();

  const serviceContext: ServiceContext = {
    name: config.project,
    version: config.release ?? "0.0.0",
    environment: config.environment,
  };

  // Dual-mode requirement (ingest-pipeline.md §6.3): prefer the Agent whenever one is actually
  // running on this host — that's the required v1 path for backend services. HttpTransport is
  // the fallback: real for browser/mobile/serverless, a dev/test convenience everywhere else
  // before an Agent is deployed. Checked once at init(), not per-flush — an Agent appearing or
  // disappearing mid-process is not a case v1 handles (a restart picks up the change).
  const transport: Transport = isAgentSocketAvailable(config.agentSocketPath)
    ? new UdsTransport({ socketPath: config.agentSocketPath })
    : new HttpTransport({
        url: config.backendUrl ?? "http://localhost:0/ingest",
        apiKey: config.apiKey,
      });

  const engine = createCaptureEngine({
    ring,
    logRing,
    sampler,
    counters,
    minLogLevel: config.minLogLevel,
  });
  let retryAfterUntilMs = 0;

  /** Sends one envelope; applies any directives. Returns false if the transport failed. */
  async function sendEnvelope(envelope: Envelope): Promise<boolean> {
    try {
      const directives = await transport.send(encodeEnvelope(envelope));
      if (directives) {
        applyDirectives(directives, sampler, suppression);
        if (directives.retryAfterSeconds !== undefined) {
          retryAfterUntilMs = Date.now() + directives.retryAfterSeconds * 1000;
        }
      }
      return true;
    } catch {
      // Transport failure: the batch is lost, but the app is unaffected and drops stay counted
      // going forward (ingest-pipeline.md §3.4/§7.2) — never throw out of the flush loop.
      return false;
    }
  }

  async function flush(): Promise<void> {
    // X-BB-Retry-After (§7.1): honor a server-requested pause before attempting to send again.
    // Capture/fold keep running underneath — only the network send is withheld, and the ring's
    // own byte cap is what protects memory if the pause outlasts the buffer.
    if (Date.now() < retryAfterUntilMs) return;

    const raws = ring.drain();
    const logs: LogEntry[] = [];
    const newFingerprintsThisFlush = new Set<string>();
    for (const raw of raws) {
      if (raw.kind === "log") {
        logs.push(buildLogEntry(raw, serviceContext)); // only if an engine was built without logRing
        continue;
      }
      processCapture(raw, {
        foldTable,
        seenFingerprints,
        newFingerprintsThisFlush,
        serviceContext,
      });
    }
    // Logs skip the fold table entirely: a log line is its own record (packages/types/src/log.ts).
    for (const raw of logRing.drain()) {
      logs.push(buildLogEntry(raw, serviceContext));
    }

    const { deltas, exemplars } = foldTable.drain();
    if (deltas.length === 0 && logs.length === 0) return;

    // One flush window of a busy service can serialize to more than the backend's request-size
    // limit; a single oversize POST is rejected whole (413), losing every line in it — errors
    // included. So logs go out in bounded batches; the error path (folds, exemplars, drop
    // counters) always rides in the FIRST envelope, with the first batch of logs.
    const [firstLogs = [], ...remainingBatches] = splitLogsIntoBatches(
      logs,
      config.flushMaxBatchBytes,
    );

    const first = buildEnvelope({
      deltas,
      exemplars,
      meta: { ...counters },
      sdkVersion: SDK_VERSION,
      newFingerprints: newFingerprintsThisFlush,
      isSuppressed: (fp) => suppression.isSuppressed(fp),
      logs: firstLogs,
    });
    if (!(await sendEnvelope(first))) return;
    counters.reset();

    for (let i = 0; i < remainingBatches.length; i++) {
      const batch = remainingBatches[i] ?? [];
      // The backend asked us to pause mid-flush: stop sending, and COUNT what we are not sending
      // rather than losing it silently (§3.4 — "drop counters are sacred").
      if (Date.now() < retryAfterUntilMs) {
        for (const rest of remainingBatches.slice(i)) counters.droppedQuota += rest.length;
        return;
      }
      const envelope = buildEnvelope({
        deltas: [],
        exemplars: [],
        meta: { ...counters },
        sdkVersion: SDK_VERSION,
        newFingerprints: newFingerprintsThisFlush,
        logs: batch,
      });
      if (!(await sendEnvelope(envelope))) {
        for (const rest of remainingBatches.slice(i)) counters.droppedQuota += rest.length;
        return;
      }
    }
  }

  // Unref'd: this timer must never be the reason the host process fails to exit
  // (ingest-pipeline.md §3.1 rule 6).
  const timer = setInterval(() => void flush(), config.flushMaxDelayMs);
  timer.unref();

  return {
    ...engine,
    log: createLogApi(engine.captureLog),
    async shutdown() {
      clearInterval(timer);
      await Promise.race([
        flush(),
        new Promise<void>((resolve) => setTimeout(resolve, config.shutdownFlushTimeoutMs)),
      ]);
    },
  };
}
