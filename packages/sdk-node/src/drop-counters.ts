import type { DropCounters } from "@bugbuster/types";

/**
 * "Drop counters are sacred" (ingest-pipeline.md §3.4) — mutable, process-local, read by the
 * worker when it builds each batch's "meta" envelope item. `reset()` is called only after a
 * successful flush, so a slow flush cycle never silently under-reports drops that happened
 * while it was in flight.
 */
export interface DropCountersHandle extends DropCounters {
  reset(): void;
}

export function createDropCounters(): DropCountersHandle {
  return {
    droppedBufferFull: 0,
    droppedQuota: 0,
    sampledOut: 0,
    bufferHighWaterBytes: 0,
    selfCpuPct: 0,
    configVersion: 0,
    reset() {
      this.droppedBufferFull = 0;
      this.droppedQuota = 0;
      this.sampledOut = 0;
      this.bufferHighWaterBytes = 0;
    },
  };
}
