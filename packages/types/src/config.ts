import { z } from "zod";

/**
 * Numeric budgets from ingest-pipeline.md's "Budgets" table / blueprint plate reference. These are
 * DEFAULTS, not hard constants — each is overridable per deployment — but the defaults themselves
 * are the documented design targets, not arbitrary round numbers.
 */
export const DEFAULT_RING_BUFFER_BYTES = 8 * 1024 * 1024; // 8 MB SDK memory ceiling
export const DEFAULT_MAX_LIVE_FINGERPRINTS = 10_000; // per process, per window
export const DEFAULT_FLUSH_MAX_BATCH_BYTES = 512 * 1024; // ~512 KB
export const DEFAULT_FLUSH_MAX_DELAY_MS = 5_000; // ~5s
export const DEFAULT_SHUTDOWN_FLUSH_TIMEOUT_MS = 2_000; // <=2s, never delay a deploy
export const DEFAULT_CONNECT_TIMEOUT_MS = 2_000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5;
export const DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;

export const SdkConfigSchema = z.object({
  /** Project/org label used for local diagnostics; auth against the backend uses apiKey. */
  project: z.string().min(1),
  apiKey: z.string().min(1),
  environment: z.string().min(1).default("production"),
  release: z.string().min(1).optional(),
  /**
   * Path the SDK probes to detect a running Agent (ingest-pipeline.md §6.3's dual-mode
   * requirement). If unreachable, the SDK falls back to HttpTransport — the documented
   * browser/mobile/serverless path, and a dev-only convenience for backend services before the
   * Agent exists (see packages/sdk-node/README.md).
   */
  agentSocketPath: z.string().min(1).default("/var/run/bugbuster/agent.sock"),
  backendUrl: z.string().url().optional(), // required only when falling back to HttpTransport
  ringBufferBytes: z.number().int().positive().default(DEFAULT_RING_BUFFER_BYTES),
  maxLiveFingerprints: z.number().int().positive().default(DEFAULT_MAX_LIVE_FINGERPRINTS),
  flushMaxBatchBytes: z.number().int().positive().default(DEFAULT_FLUSH_MAX_BATCH_BYTES),
  flushMaxDelayMs: z.number().int().positive().default(DEFAULT_FLUSH_MAX_DELAY_MS),
  shutdownFlushTimeoutMs: z.number().int().positive().default(DEFAULT_SHUTDOWN_FLUSH_TIMEOUT_MS),
});
export type SdkConfig = z.infer<typeof SdkConfigSchema>;

export const AgentConfigSchema = z.object({
  socketPath: z.string().min(1).default("/var/run/bugbuster/agent.sock"),
  backendUrl: z.string().url(),
  /**
   * v1 assumption: one Agent instance serves the one organization whose services run on this
   * host, so one API key is enough. Multi-org-per-host would need a per-connection key instead —
   * not needed at pilot scale (§10's growth triggers), so not built.
   */
  apiKey: z.string().min(1),
  diskSpoolPath: z.string().min(1).optional(),
  diskSpoolMaxBytes: z.number().int().positive().optional(),
  connectTimeoutMs: z.number().int().positive().default(DEFAULT_CONNECT_TIMEOUT_MS),
  totalTimeoutMs: z.number().int().positive().default(DEFAULT_TOTAL_TIMEOUT_MS),
  maxRetries: z.number().int().nonnegative().default(DEFAULT_MAX_RETRIES),
  circuitBreakerFailureThreshold: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_CIRCUIT_BREAKER_FAILURE_THRESHOLD),
  circuitBreakerCooldownMs: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const BackendConfigSchema = z.object({
  port: z.number().int().positive().default(8080),
  controlDbUri: z.string().min(1),
  ingestMaxBodyBytes: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_FLUSH_MAX_BATCH_BYTES * 4),
});
export type BackendConfig = z.infer<typeof BackendConfigSchema>;
