import { z } from "zod";

/**
 * The shape of a single raw event / exemplar.
 *
 * This resolves a gap between two earlier design documents: doc.md sketched an informal
 * "BugBuster event model" (event_id, trace{}, service{}, source{}, error{}) before the fold-first
 * architecture in ingest-pipeline.md existed, and the two were never explicitly reconciled.
 *
 * Resolution: this IS that shape, adopted as the canonical representation of one full-fidelity
 * EXEMPLAR — the handful of complete event payloads an issue's fold record points to (see issue.ts
 * `ExemplarRef`). It is not the aggregate itself. Two fields were added to doc.md's original sketch
 * because an exemplar only makes sense in relation to the issue it belongs to:
 *   - `fingerprint`: which issue this exemplar is evidence for
 *   - `exemplarRole`: why this particular event was kept (ingest-pipeline.md §4.1's exemplar policy)
 */

export const ExemplarRoleSchema = z.enum([
  "first",
  "last",
  "slowest",
  "one-per-release",
  "one-novel-stack",
]);
export type ExemplarRole = z.infer<typeof ExemplarRoleSchema>;

export const TraceContextSchema = z.object({
  traceId: z.string().min(1),
  spanId: z.string().min(1),
  parentSpanId: z.string().min(1).optional(),
});
export type TraceContext = z.infer<typeof TraceContextSchema>;

export const ServiceContextSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  environment: z.string().min(1),
});
export type ServiceContext = z.infer<typeof ServiceContextSchema>;

export const SourceLocationSchema = z.object({
  function: z.string().min(1),
  file: z.string().min(1),
  line: z.number().int().nonnegative(),
});
export type SourceLocation = z.infer<typeof SourceLocationSchema>;

export const ErrorDetailsSchema = z.object({
  type: z.string().min(1),
  code: z.string().optional(),
  message: z.string(),
  stacktrace: z.string(),
});
export type ErrorDetails = z.infer<typeof ErrorDetailsSchema>;

export const EventTypeSchema = z.enum(["exception", "message", "span"]);
export type EventType = z.infer<typeof EventTypeSchema>;

export const BugBusterEventSchema = z.object({
  eventId: z.string().min(1),
  fingerprint: z.string().min(1),
  exemplarRole: ExemplarRoleSchema,
  timestamp: z.string().datetime(),
  type: EventTypeSchema,
  trace: TraceContextSchema,
  service: ServiceContextSchema,
  source: SourceLocationSchema,
  // Present when type === "exception"; a "message" or "span" event may omit it.
  error: ErrorDetailsSchema.optional(),
});
export type BugBusterEvent = z.infer<typeof BugBusterEventSchema>;
