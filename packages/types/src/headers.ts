import { z } from "zod";

/**
 * Backpressure directive headers (ingest-pipeline.md §7.1) — how the backend tells the SDK to
 * generate less, not just send less. "OTel has essentially no story here"; this is BugBuster's.
 *
 * Header names are exact wire constants — do not rename without updating every SDK in the field.
 */
export const HEADER_SAMPLE_DIRECTIVE = "X-BB-Sample-Directive";
export const HEADER_SUPPRESS_FINGERPRINTS = "X-BB-Suppress-Fingerprints";
export const HEADER_RETRY_AFTER = "X-BB-Retry-After";
export const HEADER_CONFIG_VERSION = "X-BB-Config-Version";

/** Per-event-type sample rate, 0.0-1.0. e.g. {"error":1.0,"log":0.02,"span":0.005} */
export const SampleDirectiveSchema = z.object({
  error: z.number().min(0).max(1),
  log: z.number().min(0).max(1),
  span: z.number().min(0).max(1),
});
export type SampleDirective = z.infer<typeof SampleDirectiveSchema>;

/**
 * Fingerprints the backend already holds enough samples of — send counts only, no exemplar
 * payload, for the suppression window (10 minutes, per ingest-pipeline.md §7.1). Only possible
 * because fingerprinting happens client-side: the backend can name a specific fingerprint to
 * suppress rather than only being able to throttle by volume.
 */
export const SuppressFingerprintsSchema = z.array(z.string().min(1));
export type SuppressFingerprints = z.infer<typeof SuppressFingerprintsSchema>;

export const SUPPRESSION_WINDOW_MS = 10 * 60 * 1000;

/** The fully-parsed directive state an SDK or Agent applies after a response. */
export const DirectivesSchema = z.object({
  sample: SampleDirectiveSchema,
  suppressFingerprints: SuppressFingerprintsSchema,
  retryAfterSeconds: z.number().int().nonnegative().optional(),
  configVersion: z.number().int().nonnegative(),
});
export type Directives = z.infer<typeof DirectivesSchema>;

/**
 * Cause propagation (docs/architecture/root-cause-graph.md): a 5xx response from an instrumented
 * service to a traced caller names the issue it failed with, so the caller can link its own
 * errors to it. Value: a fingerprint (`CAUSE_FINGERPRINT_PATTERN`).
 */
export const HEADER_CAUSE = "X-BB-Cause";

/** What a fingerprint looks like on the wire; anything else in X-BB-Cause is ignored. */
export const CAUSE_FINGERPRINT_PATTERN = /^fp_[0-9a-f]{16}$/;
