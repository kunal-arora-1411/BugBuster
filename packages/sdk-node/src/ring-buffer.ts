/**
 * A byte-capped queue standing in for the hot path's ring buffer (ingest-pipeline.md §3.1's
 * "every buffer capped in BYTES, not items" rule, and §3.3's capture primitive).
 *
 * Implementation note: this is an array-backed FIFO with a tracked byte budget, not a literal
 * pre-allocated circular slot array. That's a deliberate v1 simplification — the CONTRACT under
 * test (fixed byte cap, O(1)-ish claim, drop-and-count on overflow, FIFO drain, no unbounded
 * growth) is what the architecture actually depends on; true zero-allocation slot reuse is a
 * later optimization, not a correctness requirement at pilot scale.
 */
export class RingBuffer<T> {
  private items: Array<{ item: T; bytes: number }> = [];
  private used = 0;

  constructor(public readonly capacityBytes: number) {
    if (capacityBytes <= 0) {
      throw new Error("RingBuffer capacityBytes must be positive");
    }
  }

  get usedBytes(): number {
    return this.used;
  }

  get length(): number {
    return this.items.length;
  }

  /**
   * Attempts to claim space for `item`. Returns false (never throws, never blocks) if the item
   * would exceed the buffer's remaining or total capacity — the caller is responsible for
   * counting the drop (packages/sdk-node/src/capture.ts increments `dropped_buffer_full`).
   */
  claim(item: T, approxBytes: number): boolean {
    if (approxBytes <= 0 || approxBytes > this.capacityBytes) {
      return false;
    }
    if (this.used + approxBytes > this.capacityBytes) {
      return false;
    }
    this.items.push({ item, bytes: approxBytes });
    this.used += approxBytes;
    return true;
  }

  /** Drains every claimed item in FIFO (insertion) order and resets the buffer to empty. */
  drain(): T[] {
    const drained = this.items.map((slot) => slot.item);
    this.items = [];
    this.used = 0;
    return drained;
  }
}
