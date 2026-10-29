import type { LogLevel } from "@bugbusterhq/types";

/** Structured context attached to a log line: `{ orderId, userId, durationMs, ... }`. */
export type LogFields = Record<string, unknown>;

/**
 * The ergonomic surface over `captureLog`: `client.log.info("order placed", { orderId })`.
 * Every method is fire-and-forget and never throws (it is `captureLog`, which swallows by design).
 */
export interface LogApi {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export function createLogApi(
  captureLog: (level: LogLevel, message: string, fields?: LogFields) => void,
): LogApi {
  return {
    debug: (message, fields) => captureLog("debug", message, fields),
    info: (message, fields) => captureLog("info", message, fields),
    warn: (message, fields) => captureLog("warn", message, fields),
    error: (message, fields) => captureLog("error", message, fields),
  };
}
