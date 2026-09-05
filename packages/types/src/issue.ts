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
});
export type Issue = z.infer<typeof IssueSchema>;

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
  exemplars: z.array(z.string().min(1)), // event IDs generated in this window; payloads travel separately in the envelope
});
export type FoldDelta = z.infer<typeof FoldDeltaSchema>;
