import { describe, expect, it } from "vitest";
import { EnvelopeSchema, NEVER_SHED_PRIORITIES } from "../../src/envelope.js";

describe("NEVER_SHED_PRIORITIES", () => {
  it("contains exactly the two priorities the shed ladder must never drop", () => {
    // ingest-pipeline.md §8.2: 5xx exemplars (8) and new-fingerprint first sightings (9)
    expect(NEVER_SHED_PRIORITIES).toEqual([8, 9]);
  });
});

describe("EnvelopeSchema", () => {
  it("accepts a valid envelope containing one of each item type", () => {
    const envelope = {
      sentAt: new Date().toISOString(),
      sdkVersion: "0.0.0",
      items: [
        {
          type: "fold" as const,
          priority: 9 as const,
          payload: {
            fingerprint: "fp_new",
            windowStart: new Date(0).toISOString(),
            windowEnd: new Date().toISOString(),
            count: 1,
            userIds: ["u1"],
            endpointCounts: { "/checkout": 1 },
            durationSamplesMs: [50],
            exemplars: ["evt_1"],
          },
        },
        {
          type: "exemplar" as const,
          priority: 9 as const,
          payload: {
            eventId: "evt_1",
            fingerprint: "fp_new",
            exemplarRole: "first" as const,
            timestamp: new Date().toISOString(),
            type: "exception" as const,
            trace: { traceId: "t1", spanId: "s1" },
            service: { name: "svc", version: "1.0.0", environment: "production" },
            source: { function: "f", file: "f.ts", line: 1 },
            error: { type: "Err", message: "boom", stacktrace: "Err: boom" },
          },
        },
        {
          type: "meta" as const,
          priority: 3 as const,
          payload: {
            droppedBufferFull: 0,
            droppedQuota: 0,
            sampledOut: 0,
            bufferHighWaterBytes: 1024,
            selfCpuPct: 0.4,
            configVersion: 1,
          },
        },
      ],
    };

    const result = EnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
    expect(result.success && result.data.items).toHaveLength(3);
  });

  it("accepts a valid envelope with zero items (an empty flush)", () => {
    const result = EnvelopeSchema.safeParse({
      sentAt: new Date().toISOString(),
      sdkVersion: "0.0.0",
      items: [],
    });
    expect(result.success).toBe(true);
  });
});
