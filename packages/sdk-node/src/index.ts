import type { ServiceContext } from "@bugbuster/types";
import { SdkConfigSchema, type SdkConfig } from "@bugbuster/types";
import { RingBuffer } from "./ring-buffer.js";
import { createSampler } from "./sampler.js";
import { createDropCounters } from "./drop-counters.js";
import { createCaptureEngine, type CaptureEngine } from "./capture.js";
import type { RawCapture } from "./raw-capture.js";
import { FoldTable } from "./worker/fold.js";
import { processCapture } from "./worker/pipeline.js";
import { buildEnvelope, encodeEnvelope } from "./worker/serialize.js";
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

const SDK_VERSION = "0.0.0";

export interface BugBusterClient extends CaptureEngine {
  /** Forces an immediate flush of everything currently held, bounded by shutdownFlushTimeoutMs. */
  shutdown(): Promise<void>;
}

export function init(rawConfig: unknown): BugBusterClient {
  const config: SdkConfig = SdkConfigSchema.parse(rawConfig);

  const ring = new RingBuffer<RawCapture>(config.ringBufferBytes);
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

  const engine = createCaptureEngine({ ring, sampler, counters });
  let retryAfterUntilMs = 0;

  async function flush(): Promise<void> {
    // X-BB-Retry-After (§7.1): honor a server-requested pause before attempting to send again.
    // Capture/fold keep running underneath — only the network send is withheld, and the ring's
    // own byte cap is what protects memory if the pause outlasts the buffer.
    if (Date.now() < retryAfterUntilMs) return;

    const raws = ring.drain();
    const newFingerprintsThisFlush = new Set<string>();
    for (const raw of raws) {
      processCapture(raw, {
        foldTable,
        seenFingerprints,
        newFingerprintsThisFlush,
        serviceContext,
      });
    }

    const { deltas, exemplars } = foldTable.drain();
    if (deltas.length === 0) return;

    const envelope = buildEnvelope({
      deltas,
      exemplars,
      meta: { ...counters },
      sdkVersion: SDK_VERSION,
      newFingerprints: newFingerprintsThisFlush,
      isSuppressed: (fp) => suppression.isSuppressed(fp),
    });

    try {
      const directives = await transport.send(encodeEnvelope(envelope));
      if (directives) {
        applyDirectives(directives, sampler, suppression);
        if (directives.retryAfterSeconds !== undefined) {
          retryAfterUntilMs = Date.now() + directives.retryAfterSeconds * 1000;
        }
      }
      counters.reset();
    } catch {
      // Transport failure: the batch is lost, but the app is unaffected and drops stay counted
      // going forward (ingest-pipeline.md §3.4/§7.2) — never throw out of the flush loop.
    }
  }

  // Unref'd: this timer must never be the reason the host process fails to exit
  // (ingest-pipeline.md §3.1 rule 6).
  const timer = setInterval(() => void flush(), config.flushMaxDelayMs);
  timer.unref();

  return {
    ...engine,
    async shutdown() {
      clearInterval(timer);
      await Promise.race([
        flush(),
        new Promise<void>((resolve) => setTimeout(resolve, config.shutdownFlushTimeoutMs)),
      ]);
    },
  };
}
