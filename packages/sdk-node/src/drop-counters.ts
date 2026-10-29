import type { DropCounters } from "@bugbusterhq/types";

/**
 * "Drop counters are sacred" (ingest-pipeline.md §3.4) — mutable, process-local, read by the
 * worker when it builds each batch's "meta" envelope item. Counters are only consumed after a
 * successful send, so a failed flush never loses them.
 */
export interface DropCountersHandle extends DropCounters {
  /**
   * Subtracts a snapshot that was just sent successfully. Not a reset to zero: drops counted while
   * that send was in flight survive into the next report instead of being zeroed unreported.
   */
  consume(sent: DropCounters): void;
}

export function createDropCounters(): DropCountersHandle {
  return {
    droppedBufferFull: 0,
    droppedQuota: 0,
    sampledOut: 0,
    bufferHighWaterBytes: 0,
    selfCpuPct: 0,
    configVersion: 0,
    consume(sent) {
      this.droppedBufferFull = Math.max(0, this.droppedBufferFull - sent.droppedBufferFull);
      this.droppedQuota = Math.max(0, this.droppedQuota - sent.droppedQuota);
      this.sampledOut = Math.max(0, this.sampledOut - sent.sampledOut);
      // A high-water mark, not a sum: it restarts only if nothing exceeded it since the snapshot.
      if (this.bufferHighWaterBytes <= sent.bufferHighWaterBytes) this.bufferHighWaterBytes = 0;
    },
  };
}
