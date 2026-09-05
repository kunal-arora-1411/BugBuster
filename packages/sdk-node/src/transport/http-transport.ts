import type { Directives, SampleDirective } from "@bugbuster/types";
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TOTAL_TIMEOUT_MS,
  HEADER_CONFIG_VERSION,
  HEADER_RETRY_AFTER,
  HEADER_SAMPLE_DIRECTIVE,
  HEADER_SUPPRESS_FINGERPRINTS,
} from "@bugbuster/types";
import type { Transport } from "./transport.js";
import { TransportError } from "./transport.js";

/**
 * Direct-to-backend transport over HTTPS.
 *
 * NOT the production path for backend-hosted SDKs (ingest-pipeline.md §6.3: the Agent, over UDS,
 * is required there). This exists for two legitimate reasons only:
 *   1. The documented fallback for browser/mobile/serverless, where no host-local Agent can run.
 *   2. A development convenience for this package's own tests before packages/agent exists —
 *      never wired up as the default in a real deployment (see packages/sdk-node/README.md).
 */
export interface HttpTransportOptions {
  url: string;
  apiKey: string;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_SAMPLE: SampleDirective = { error: 1, log: 1, span: 1 };

function fullJitter(attempt: number, baseMs = 500, capMs = 8000): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.random() * ceiling;
}

function parseDirectivesFromHeaders(headers: Headers): Directives {
  let sample = DEFAULT_SAMPLE;
  const sampleRaw = headers.get(HEADER_SAMPLE_DIRECTIVE);
  if (sampleRaw) {
    try {
      sample = { ...DEFAULT_SAMPLE, ...JSON.parse(sampleRaw) };
    } catch {
      // malformed header from a misbehaving server — keep defaults, never throw
    }
  }

  let suppressFingerprints: string[] = [];
  const suppressRaw = headers.get(HEADER_SUPPRESS_FINGERPRINTS);
  if (suppressRaw) {
    try {
      const parsed = JSON.parse(suppressRaw);
      if (Array.isArray(parsed)) suppressFingerprints = parsed;
    } catch {
      // ditto
    }
  }

  const retryAfterRaw = headers.get(HEADER_RETRY_AFTER);
  const retryAfterSeconds = retryAfterRaw ? Number(retryAfterRaw) : undefined;

  const configVersionRaw = headers.get(HEADER_CONFIG_VERSION);
  const configVersion = configVersionRaw ? Number(configVersionRaw) : 0;

  return {
    sample,
    suppressFingerprints,
    retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
    configVersion: Number.isFinite(configVersion) ? configVersion : 0,
  };
}

export class HttpTransport implements Transport {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpTransportOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(payload: Buffer): Promise<Directives | undefined> {
    const maxRetries = this.options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const totalTimeoutMs = this.options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
    void (this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS); // fetch has no separate connect-phase timeout; total budget governs both, documented limitation

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), totalTimeoutMs);
      try {
        const res = await this.fetchImpl(this.options.url, {
          method: "POST",
          headers: {
            "content-type": "application/x-ndjson",
            authorization: `Bearer ${this.options.apiKey}`,
          },
          body: payload,
          signal: controller.signal,
        });

        if (res.status === 202 || res.ok) {
          return parseDirectivesFromHeaders(res.headers);
        }

        // Never retry 4xx — retrying a malformed/unauthorized request forever is how a
        // monitoring agent becomes the outage (ingest-pipeline.md §7.2).
        if (res.status >= 400 && res.status < 500) {
          throw new TransportError(`ingest rejected batch: HTTP ${res.status}`, false);
        }

        // 5xx: retryable.
        lastError = new TransportError(`ingest error: HTTP ${res.status}`, true);
      } catch (err) {
        if (err instanceof TransportError && !err.retryable) {
          throw err;
        }
        lastError = err;
      } finally {
        clearTimeout(timer);
      }

      if (attempt < maxRetries) {
        await sleep(fullJitter(attempt));
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new TransportError("ingest unreachable after retries", true);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
