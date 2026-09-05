import { zstdCompressSync } from "node:zlib";
import type { Directives, SampleDirective } from "@bugbuster/types";
import {
  HEADER_CONFIG_VERSION,
  HEADER_RETRY_AFTER,
  HEADER_SAMPLE_DIRECTIVE,
  HEADER_SUPPRESS_FINGERPRINTS,
} from "@bugbuster/types";
import { CircuitBreaker } from "./circuit-breaker.js";

/**
 * The Agent's one persistent-connection-per-node hop to the backend (ingest-pipeline.md §6.2,
 * §6.4, §7.2). Owns everything the SDK deliberately doesn't: TLS, compression, bounded jittered
 * retries, and the circuit breaker.
 *
 * Compression: plain zstd via Node's native `node:zlib` (available since Node 22.15/23.8 — no
 * external dependency needed). No trained dictionary yet (§3 of the implementation plan) — there
 * is no representative payload corpus to train one on until real traffic has flowed.
 */
export interface HttpClientOptions {
  url: string;
  apiKey: string;
  totalTimeoutMs?: number;
  maxRetries?: number;
  circuitBreaker?: CircuitBreaker;
}

const DEFAULT_SAMPLE: SampleDirective = { error: 1, log: 1, span: 1 };

function fullJitter(attempt: number, baseMs = 500, capMs = 8000): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.random() * ceiling;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDirectivesFromHeaders(headers: Headers): Directives {
  let sample = DEFAULT_SAMPLE;
  const sampleRaw = headers.get(HEADER_SAMPLE_DIRECTIVE);
  if (sampleRaw) {
    try {
      sample = { ...DEFAULT_SAMPLE, ...JSON.parse(sampleRaw) };
    } catch {
      /* malformed header — keep defaults */
    }
  }
  let suppressFingerprints: string[] = [];
  const suppressRaw = headers.get(HEADER_SUPPRESS_FINGERPRINTS);
  if (suppressRaw) {
    try {
      const parsed = JSON.parse(suppressRaw);
      if (Array.isArray(parsed)) suppressFingerprints = parsed;
    } catch {
      /* ditto */
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

export class AgentHttpClientError extends Error {}

export class AgentHttpClient {
  private readonly breaker: CircuitBreaker;

  constructor(private readonly options: HttpClientOptions) {
    this.breaker =
      options.circuitBreaker ?? new CircuitBreaker({ failureThreshold: 5, cooldownMs: 30_000 });
  }

  /** True if a send was even attempted (false means the breaker failed it instantly). */
  async send(payload: Buffer): Promise<{ attempted: boolean; directives?: Directives }> {
    if (!this.breaker.canAttempt()) {
      return { attempted: false };
    }

    const compressed = zstdCompressSync(payload);
    const maxRetries = this.options.maxRetries ?? 3;
    const totalTimeoutMs = this.options.totalTimeoutMs ?? 10_000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), totalTimeoutMs);
      try {
        const res = await fetch(this.options.url, {
          method: "POST",
          headers: {
            "content-type": "application/x-ndjson",
            "content-encoding": "zstd",
            authorization: `Bearer ${this.options.apiKey}`,
          },
          body: compressed,
          signal: controller.signal,
        });

        if (res.status === 202 || res.ok) {
          this.breaker.onSuccess();
          return { attempted: true, directives: parseDirectivesFromHeaders(res.headers) };
        }

        if (res.status >= 400 && res.status < 500) {
          this.breaker.onFailure();
          throw new AgentHttpClientError(`backend rejected batch: HTTP ${res.status}`);
        }
        // 5xx — retryable within this attempt loop before counting a breaker failure.
        if (attempt === maxRetries) this.breaker.onFailure();
      } catch (err) {
        if (err instanceof AgentHttpClientError) throw err;
        if (attempt === maxRetries) this.breaker.onFailure();
      } finally {
        clearTimeout(timer);
      }
      if (attempt < maxRetries) await sleep(fullJitter(attempt));
    }

    throw new AgentHttpClientError("backend unreachable after retries");
  }
}
