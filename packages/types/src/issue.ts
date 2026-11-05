import { z } from "zod";
import { ExemplarRoleSchema } from "./event.js";

/**
 * The fold/aggregate record — one per fingerprint, per org.
 *
 * ingest-pipeline.md §4.2: `usersAffected`, `duration`, and `topEndpoints` are typed here in their
 * EXACT v1 shape (computed directly, not approximated). This is deliberate: at pilot scale, exact
 * computation is both cheap and more accurate than a sketch. The field NAMES are chosen to be
 * stable across the eventual v2 upgrade (HyperLogLog for `usersAffected`, DDSketch for `duration`,
 * Space-Saving top-K for `topEndpoints`) — swapping the VALUE representation later is a value-type
 * change to these three fields, not a schema migration or a rename anywhere else in the system.
 */

export const DurationPercentilesSchema = z.object({
  p50: z.number().nonnegative(),
  p95: z.number().nonnegative(),
  p99: z.number().nonnegative(),
});
export type DurationPercentiles = z.infer<typeof DurationPercentilesSchema>;

export const TopEndpointEntrySchema = z.object({
  endpoint: z.string().min(1),
  count: z.number().int().nonnegative(),
});
export type TopEndpointEntry = z.infer<typeof TopEndpointEntrySchema>;

export const TopEndpointsSchema = z.object({
  top: z.array(TopEndpointEntrySchema),
  other: z.number().int().nonnegative(),
});
export type TopEndpoints = z.infer<typeof TopEndpointsSchema>;

export const ExemplarRefSchema = z.object({
  eventId: z.string().min(1),
  role: ExemplarRoleSchema,
});
export type ExemplarRef = z.infer<typeof ExemplarRefSchema>;

/**
 * An issue's strongest cause: another issue that failed first, downstream, in the same requests.
 * `share` is `count / issue.count` — how much of this issue that cause explains.
 */
export const IssueCauseSchema = z.object({
  fingerprint: z.string().min(1),
  count: z.number().int().nonnegative(),
  share: z.number().min(0).max(1),
});
export type IssueCause = z.infer<typeof IssueCauseSchema>;

/** At or above this share, an issue counts as a symptom of its cause (root-cause-graph.md §6). */
/** Longest error message kept on an issue's title; the full message stays on its example events. */
export const ISSUE_TITLE_MAX_CHARS = 500;

export const IssueSchema = z.object({
  fingerprint: z.string().min(1),
  count: z.number().int().nonnegative(),
  usersAffected: z.number().int().nonnegative(),
  duration: DurationPercentilesSchema,
  topEndpoints: TopEndpointsSchema,
  releases: z.array(z.string().min(1)),
  firstSeen: z.string().datetime(),
  lastSeen: z.string().datetime(),
  // Capped at 6 (ingest-pipeline.md §4.1); the cap is enforced in application code
  // (packages/backend/src/ingest/processor.ts), not in this schema.
  exemplarRefs: z.array(ExemplarRefSchema),
  // Sampling weight. Defaults to 1.0 (no sampling applied). ingest-pipeline.md §5.2:
  // "Always store the sampling weight" — never present a sampled count as unconditional truth.
  adjustedCount: z.number().positive().default(1.0),
  /**
   * What the error says, from the issue's first stored example event: its error type and
   * message (the message capped at ISSUE_TITLE_MAX_CHARS). Lets a list of issues read as errors
   * without fetching every issue's examples. Absent until the issue has an example event.
   */
  title: z.object({ type: z.string(), message: z.string() }).optional(),
  /**
   * Every service (the SDK's `project`) this issue has been seen in. Errors are grouped per
   * service, so this is normally one name; an issue from before that, or the shared overflow
   * bucket, can list several. Empty for an issue no service was ever recorded for.
   */
  services: z.array(z.string().min(1)).default([]),
  /** Every environment (`production`, `staging`, …) this issue has been seen in. */
  environments: z.array(z.string().min(1)).default([]),
  /** This issue's strongest cause in another service, when one has been recorded. */
  causedBy: IssueCauseSchema.optional(),
});
export type Issue = z.infer<typeof IssueSchema>;

export const SYMPTOM_MIN_SHARE = 0.5;

/** Most causes one fold delta carries; more distinct causes in one window are not recorded. */
export const MAX_CAUSES_PER_DELTA = 16;

/**
 * What the SDK/Agent actually transmits per flush window for a given fingerprint — the raw
 * ingredients for one fold window, not the persisted aggregate. The backend merges a stream of
 * these into the persisted `Issue` (packages/backend/src/db/collections/issues.ts) via an atomic
 * upsert, which is why this shape carries per-window raw values (a window's user IDs, duration
 * samples, endpoint counts) rather than pre-computed percentiles or cardinality — those are only
 * correct once merged across every window and every process that observed the fingerprint.
 */
export const FoldDeltaSchema = z.object({
  fingerprint: z.string().min(1),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  count: z.number().int().positive(),
  userIds: z.array(z.string().min(1)),
  endpointCounts: z.record(z.string(), z.number().int().nonnegative()),
  durationSamplesMs: z.array(z.number().nonnegative()),
  release: z.string().min(1).optional(),
  /** The service that saw these occurrences (its `project`). Absent from SDKs before 0.3.0. */
  service: z.string().min(1).optional(),
  exemplars: z.array(z.string().min(1)), // event IDs generated in this window; payloads travel separately in the envelope
  /**
   * Cause and effect across services (docs/architecture/root-cause-graph.md): for each issue
   * another service failed with (its fingerprint, from that service's X-BB-Cause response
   * header), how many of this window's occurrences followed that failure in the same request.
   * Absent when none did, and from SDKs before 0.4.0.
   */
  causedBy: z.record(z.string(), z.number().int().positive()).optional(),
});
export type FoldDelta = z.infer<typeof FoldDeltaSchema>;
