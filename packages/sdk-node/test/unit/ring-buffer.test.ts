import { describe, expect, it } from "vitest";
import { RingBuffer } from "../../src/ring-buffer.js";

describe("RingBuffer", () => {
  it("claim() on an empty buffer succeeds", () => {
    const ring = new RingBuffer<string>(1024);
    expect(ring.claim("a", 10)).toBe(true);
  });

  it("claim() repeated past byte capacity returns false without throwing or blocking", () => {
    const ring = new RingBuffer<string>(100);
    let accepted = 0;
    for (let i = 0; i < 50; i++) {
      if (ring.claim(`item-${i}`, 10)) accepted++;
    }
    expect(accepted).toBe(10); // exactly capacity/itemSize fit
    expect(ring.claim("overflow", 10)).toBe(false);
  });

  it("rejects a single valid item larger than remaining capacity, counted by the caller as dropped_buffer_full", () => {
    const ring = new RingBuffer<string>(100);
    ring.claim("small", 90);
    expect(ring.claim("too-big-for-remainder", 20)).toBe(false);
    expect(ring.usedBytes).toBe(90); // rejected claim must not partially consume capacity
  });

  it("rejects an item larger than the buffer's total capacity outright", () => {
    const ring = new RingBuffer<string>(50);
    expect(ring.claim("huge", 1000)).toBe(false);
  });

  it("drain() returns items in FIFO insertion order and empties the buffer", () => {
    const ring = new RingBuffer<string>(1000);
    ring.claim("first", 10);
    ring.claim("second", 10);
    ring.claim("third", 10);
    expect(ring.drain()).toEqual(["first", "second", "third"]);
    expect(ring.usedBytes).toBe(0);
    expect(ring.length).toBe(0);
  });
});
