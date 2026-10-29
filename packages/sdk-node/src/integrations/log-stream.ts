import { Writable } from "node:stream";
import type { LogLevel } from "@bugbusterhq/types";
import type { CaptureEngine } from "../capture.js";

/**
 * A writable stream that turns JSON log lines into BugBuster log entries — so an application that
 * already logs through pino or winston gets its logs into BugBuster with one line of wiring and
 * zero changes to its existing `logger.info(...)` calls:
 *
 * ```ts
 * // pino — any writable works as pino's destination:
 * const logger = pino(createLogStream(client));
 *
 * // winston — via its built-in Stream transport:
 * const logger = winston.createLogger({
 *   format: winston.format.json(),
 *   transports: [new winston.transports.Stream({ stream: createLogStream(client) })],
 * });
 * ```
 *
 * It understands both shapes: pino's numeric `level` (10-60) and `msg`, and winston's string
 * `level` and `message`. Everything else on the line becomes structured `fields`. A line that is
 * not JSON is recorded as-is at `defaultLevel`.
 *
 * Cost note: unlike `captureLog` itself (the <5µs hot path), this adapter does a `JSON.parse` per
 * line in the logger's own call stack. That is the price of accepting an already-serialized line;
 * code that logs directly with `client.log.*` avoids it.
 */
export interface LogStreamOptions {
  /** Level used for lines with no recognizable level (plain text). Default "info". */
  defaultLevel?: LogLevel;
}

// Keys that are envelope, not payload: they are consumed above or are noise on every line.
const RESERVED_KEYS = new Set([
  "level",
  "msg",
  "message",
  "time",
  "timestamp",
  "pid",
  "hostname",
  "v",
]);

const MAX_PENDING_LINE_CHARS = 64 * 1024;

function levelFromNumber(n: number): LogLevel {
  // pino: trace 10, debug 20, info 30, warn 40, error 50, fatal 60
  if (n <= 20) return "debug";
  if (n <= 30) return "info";
  if (n <= 40) return "warn";
  return "error";
}

function levelFromString(raw: string): LogLevel | undefined {
  switch (raw.toLowerCase()) {
    case "trace":
    case "debug":
    case "verbose":
    case "silly":
      return "debug";
    case "info":
    case "http":
    case "notice":
      return "info";
    case "warn":
    case "warning":
      return "warn";
    case "error":
    case "err":
    case "fatal":
    case "crit":
    case "critical":
    case "alert":
    case "emerg":
      return "error";
    default:
      return undefined;
  }
}

export function createLogStream(
  client: Pick<CaptureEngine, "captureLog">,
  options: LogStreamOptions = {},
): Writable {
  const defaultLevel = options.defaultLevel ?? "info";
  let pending = "";

  function forward(line: string): void {
    const text = line.trim();
    if (text.length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      client.captureLog(defaultLevel, text);
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      client.captureLog(defaultLevel, text);
      return;
    }

    const obj = parsed as Record<string, unknown>;
    const rawLevel = obj.level;
    const level =
      (typeof rawLevel === "number"
        ? levelFromNumber(rawLevel)
        : typeof rawLevel === "string"
          ? levelFromString(rawLevel)
          : undefined) ?? defaultLevel;

    const message =
      typeof obj.msg === "string" ? obj.msg : typeof obj.message === "string" ? obj.message : "";

    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (!RESERVED_KEYS.has(key)) fields[key] = value;
    }

    client.captureLog(level, message.length > 0 ? message : "(no message)", fields);
  }

  return new Writable({
    decodeStrings: false,
    write(chunk: string | Buffer, _encoding, callback) {
      pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        forward(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      // A "line" that never ends must not grow without bound.
      if (pending.length > MAX_PENDING_LINE_CHARS) {
        forward(pending);
        pending = "";
      }
      callback();
    },
    final(callback) {
      forward(pending);
      pending = "";
      callback();
    },
  });
}
