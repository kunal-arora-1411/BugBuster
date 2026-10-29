import { z } from "zod";
import { ServiceContextSchema } from "./event.js";

/**
 * A single application log line — the "normal logs" half of BugBuster's observability story.
 *
 * Unlike an exception or a `captureMessage`, a log is NEVER fingerprinted or folded. The whole
 * point of a log is that the individual line (and its place in time) is the record; collapsing
 * 10,000 "order placed" lines into `count: 10000` would destroy exactly what a developer reads
 * logs for. Logs travel beside the fold path in the same envelope, as `type: "log"` items, and
 * are stored one document per line (packages/backend/src/db/collections/logs.ts).
 *
 * What logs DO share with the error path: the same SDK hot path (never block, never throw, byte-
 * capped buffer, drop-and-count), the same redaction, the same Agent hop, the same tenant
 * isolation, and — via `trace` — the same trace context. That last one is what makes the two
 * halves useful together: an issue's exemplar carries a `traceId`, and every log line written
 * during that request carries the same one.
 */

export const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

/** Numeric severity, lowest first — what `minLogLevel` and level filters compare against. */
export const LOG_LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** Hard ceilings enforced by the SDK (truncate) and again by the backend (never trust the wire). */
export const MAX_LOG_MESSAGE_CHARS = 8 * 1024;
export const MAX_LOG_FIELDS_BYTES = 16 * 1024;

export const LogTraceSchema = z.object({
  traceId: z.string().min(1),
  spanId: z.string().min(1).optional(),
});
export type LogTrace = z.infer<typeof LogTraceSchema>;

export const LogEntrySchema = z.object({
  /** Client-generated unique id — makes a retried batch idempotent (unique index backend-side). */
  logId: z.string().min(1),
  timestamp: z.string().datetime(),
  level: LogLevelSchema,
  message: z.string(),
  /** Structured key/value context. JSON-safe by construction (the SDK sanitizes before sending). */
  fields: z.record(z.string(), z.unknown()).optional(),
  trace: LogTraceSchema.optional(),
  service: ServiceContextSchema,
});
export type LogEntry = z.infer<typeof LogEntrySchema>;
