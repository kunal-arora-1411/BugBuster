import { describe, expect, it } from "vitest";
import { decodeEnvelopeItems, encodeEnvelope } from "../../src/codec.js";
import type { Envelope } from "../../src/envelope.js";

function validEnvelope(): Envelope {
  return {
    sentAt: new Date().toISOString(),
    sdkVersion: "0.0.0",
    items: [
      {
        type: "meta",
        priority: 3,
        payload: {
          droppedBufferFull: 0,
          droppedQuota: 0,
          sampledOut: 0,
          bufferHighWaterBytes: 0,
          selfCpuPct: 0,
          configVersion: 1,
        },
      },
    ],
  };
}

describe("encodeEnvelope / decodeEnvelopeItems round trip", () => {
  it("round-trips a valid envelope's items exactly", () => {
    const envelope = validEnvelope();
    const decoded = decodeEnvelopeItems(encodeEnvelope(envelope));
    expect(decoded).toEqual(envelope.items);
  });

  it("recovers every complete item from a buffer truncated mid-final-item", () => {
    const envelope: Envelope = {
      ...validEnvelope(),
      items: [...validEnvelope().items, ...validEnvelope().items], // two complete items
    };
    const full = encodeEnvelope(envelope);
    const truncated = full.subarray(0, full.length - 5); // chop into the middle of the last line
    const decoded = decodeEnvelopeItems(truncated);
    expect(decoded).toHaveLength(1); // first complete item survives; the torn one is dropped
  });

  it("encodes zero items as an empty (but valid, zero-length) buffer", () => {
    const envelope: Envelope = { ...validEnvelope(), items: [] };
    expect(encodeEnvelope(envelope).length).toBe(0);
    expect(decodeEnvelopeItems(encodeEnvelope(envelope))).toEqual([]);
  });
});
