import type { FoldDelta } from "@bugbuster/types";

/**
 * Cross-process folding (ingest-pipeline.md §6.2) — the Agent's actual reason to exist. Multiple
 * SDK-instrumented services on the SAME host each fold in isolation; the Agent sees all of them
 * and merges same-fingerprint deltas together before the one network hop to the backend, which is
 * exactly the fold ratio improvement direct-mode can't get (blueprint plate 04).
 *
 * v1 simplification: `release` is a single optional string on FoldDelta (not a set), so a merge
 * spanning two different releases keeps only the earlier delta's release rather than a union. At
 * pilot scale a fingerprint spanning a deploy boundary within one flush window is rare enough that
 * this doesn't matter in practice; the persisted Issue's `releases` array (built by the backend
 * from many deltas over time, not from one merge) is unaffected by this shortcut.
 */
export function mergeFoldDeltas(deltas: readonly FoldDelta[]): FoldDelta[] {
  const byFingerprint = new Map<string, FoldDelta>();

  for (const delta of deltas) {
    const existing = byFingerprint.get(delta.fingerprint);
    if (!existing) {
      byFingerprint.set(delta.fingerprint, { ...delta, userIds: [...delta.userIds] });
      continue;
    }

    existing.count += delta.count;
    existing.userIds = [...new Set([...existing.userIds, ...delta.userIds])];
    existing.durationSamplesMs = [...existing.durationSamplesMs, ...delta.durationSamplesMs];
    existing.exemplars = [...existing.exemplars, ...delta.exemplars];
    existing.windowStart =
      delta.windowStart < existing.windowStart ? delta.windowStart : existing.windowStart;
    existing.windowEnd =
      delta.windowEnd > existing.windowEnd ? delta.windowEnd : existing.windowEnd;

    for (const [endpoint, count] of Object.entries(delta.endpointCounts)) {
      existing.endpointCounts[endpoint] = (existing.endpointCounts[endpoint] ?? 0) + count;
    }
  }

  return [...byFingerprint.values()];
}
