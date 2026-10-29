import { describe, expect, it } from "vitest";
import { EnvelopeSchema } from "../../src/envelope.js";
import { LOG_LEVEL_ORDER, LogEntrySchema, LogLevelSchema } from "../../src/log.js";
import { SdkConfigSchema } from "../../src/config.js";
import { decodeEnvelopeItems, encodeEnvelope } from "../../src/codec.js";

const service = { name: "checkout-svc", version: "1.4.2", environment: "production" };

function validLog() {
  return {
    logId: "log_1",
    timestamp: new Date().toISOString(),
    level: "info" as const,
    message: "order placed",
    fields: { orderId: "o_123", items: 3 },
    trace: { traceId: "trace-abc", spanId: "span-1" },
    service,
  };
}

describe("LogEntrySchema", () => {
  it("accepts a full log line", () => {
    expect(LogEntrySchema.safeParse(validLog()).success).toBe(true);
  });

  it("accepts a minimal log line (no fields, no trace)", () => {
    const { fields: _f, trace: _t, ...minimal } = validLog();
    expect(LogEntrySchema.safeParse(minimal).success).toBe(true);
  });

  it("rejects an unknown level, a non-ISO timestamp, and a missing logId", () => {
    expect(LogEntrySchema.safeParse({ ...validLog(), level: "fatal" }).success).toBe(false);
    expect(LogEntrySchema.safeParse({ ...validLog(), timestamp: "yesterday" }).success).toBe(false);
    expect(LogEntrySchema.safeParse({ ...validLog(), logId: "" }).success).toBe(false);
  });
});

describe("LOG_LEVEL_ORDER", () => {
  it("is strictly increasing debug < info < warn < error and covers every level", () => {
    const levels = LogLevelSchema.options;
    for (const level of levels) expect(LOG_LEVEL_ORDER[level]).toBeTypeOf("number");
    expect(LOG_LEVEL_ORDER.debug).toBeLessThan(LOG_LEVEL_ORDER.info);
    expect(LOG_LEVEL_ORDER.info).toBeLessThan(LOG_LEVEL_ORDER.warn);
    expect(LOG_LEVEL_ORDER.warn).toBeLessThan(LOG_LEVEL_ORDER.error);
  });
});

describe("log envelope items", () => {
  it("an envelope carrying a log item validates and survives the NDJSON codec round-trip", () => {
    const envelope = {
      sentAt: new Date().toISOString(),
      sdkVersion: "0.0.0",
      items: [{ type: "log" as const, priority: 1 as const, payload: validLog() }],
    };
    expect(EnvelopeSchema.safeParse(envelope).success).toBe(true);
    const decoded = decodeEnvelopeItems(encodeEnvelope(envelope));
    expect(decoded).toEqual(envelope.items);
  });

  it("rejects a log item whose payload is not a valid LogEntry", () => {
    const envelope = {
      sentAt: new Date().toISOString(),
      sdkVersion: "0.0.0",
      items: [{ type: "log", priority: 1, payload: { message: "no id, no level" } }],
    };
    expect(EnvelopeSchema.safeParse(envelope).success).toBe(false);
  });
});

describe("SdkConfigSchema.minLogLevel", () => {
  it("defaults to info and accepts any valid level", () => {
    const base = { project: "p", apiKey: "k" };
    expect(SdkConfigSchema.parse(base).minLogLevel).toBe("info");
    expect(SdkConfigSchema.parse({ ...base, minLogLevel: "debug" }).minLogLevel).toBe("debug");
    expect(SdkConfigSchema.safeParse({ ...base, minLogLevel: "trace" }).success).toBe(false);
  });
});
