import { z } from "zod";
import { BugBusterEventSchema } from "./event.js";
import { FoldDeltaSchema } from "./issue.js";

/**
 * Priority byte stamped on every envelope item (ingest-pipeline.md §8.2's shed ladder), so the
 * ingest edge can decide what to drop under pressure WITHOUT parsing the item payload — only this
 * header needs to be read.
 *
 * NEVER_SHED_PRIORITIES (8, 9) must survive shedding under all circumstances: a first sighting of
 * a new fingerprint (9) is the highest-information byte in the system, and a 5xx exemplar (8) is
 * the evidence an on-call engineer needs most.
 */
export const PrioritySchema = z.union([
  z.literal(0), // debug logs
  z.literal(1), // info logs
  z.literal(2), // spans on healthy endpoints
  z.literal(3), // aggregate counts (non-error)
  z.literal(8), // 5xx exemplars — never shed
  z.literal(9), // first occurrence of a new fingerprint — never shed
]);
export type Priority = z.infer<typeof PrioritySchema>;

export const NEVER_SHED_PRIORITIES: readonly Priority[] = [8, 9];

/**
 * Per-batch fidelity metadata (ingest-pipeline.md §3.4 — "drop counters are sacred"). Carried in
 * every batch so the dashboard can always state its own fidelity rather than silently presenting
 * degraded data as complete.
 */
export const DropCountersSchema = z.object({
  droppedBufferFull: z.number().int().nonnegative(),
  droppedQuota: z.number().int().nonnegative(),
  sampledOut: z.number().int().nonnegative(),
  bufferHighWaterBytes: z.number().int().nonnegative(),
  selfCpuPct: z.number().min(0).max(100),
  configVersion: z.number().int().nonnegative(),
});
export type DropCounters = z.infer<typeof DropCountersSchema>;

export const EnvelopeItemSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fold"), priority: PrioritySchema, payload: FoldDeltaSchema }),
  z.object({
    type: z.literal("exemplar"),
    priority: PrioritySchema,
    payload: BugBusterEventSchema,
  }),
  z.object({ type: z.literal("meta"), priority: PrioritySchema, payload: DropCountersSchema }),
]);
export type EnvelopeItem = z.infer<typeof EnvelopeItemSchema>;

/**
 * The batch unit transported SDK-\>Agent (UDS) and Agent-\>backend (HTTPS).
 *
 * On the wire this is framed as newline-delimited, length-prefixed items (ingest-pipeline.md
 * §6.5 — Sentry's envelope model), so a truncated payload still yields every complete item before
 * the tear. `Envelope` here is the DECODED, in-memory shape; the framing/length-prefixing is a
 * transport-layer concern implemented in packages/sdk-node/src/worker/serialize.ts and
 * packages/agent/src/uds-server.ts, not part of this type.
 */
export const EnvelopeSchema = z.object({
  sentAt: z.string().datetime(),
  sdkVersion: z.string().min(1),
  items: z.array(EnvelopeItemSchema),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;
