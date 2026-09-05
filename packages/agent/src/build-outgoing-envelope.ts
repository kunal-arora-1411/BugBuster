import type {
  BugBusterEvent,
  DropCounters,
  Envelope,
  EnvelopeItem,
  FoldDelta,
  Priority,
} from "@bugbuster/types";

/** Combines drop-counter meta records from every SDK connection this window into one. */
export function mergeDropCounters(all: readonly DropCounters[]): DropCounters {
  return all.reduce<DropCounters>(
    (acc, c) => ({
      droppedBufferFull: acc.droppedBufferFull + c.droppedBufferFull,
      droppedQuota: acc.droppedQuota + c.droppedQuota,
      sampledOut: acc.sampledOut + c.sampledOut,
      bufferHighWaterBytes: Math.max(acc.bufferHighWaterBytes, c.bufferHighWaterBytes),
      selfCpuPct: Math.max(acc.selfCpuPct, c.selfCpuPct),
      configVersion: Math.max(acc.configVersion, c.configVersion),
    }),
    {
      droppedBufferFull: 0,
      droppedQuota: 0,
      sampledOut: 0,
      bufferHighWaterBytes: 0,
      selfCpuPct: 0,
      configVersion: 0,
    },
  );
}

export interface PrioritizedFoldDelta {
  priority: Priority;
  payload: FoldDelta;
}

export interface PrioritizedExemplar {
  priority: Priority;
  payload: BugBusterEvent;
}

/**
 * Builds the Agent's outgoing (already cross-process-folded) envelope for one flush window.
 *
 * Priority preservation matters here: if ANY contributing SDK marked a fingerprint's fold delta
 * priority 9 (a new-fingerprint first sighting — ingest-pipeline.md §8.2's "never shed" tier),
 * the merged record must keep priority 9, not silently fall back to a mergeable default. Merging
 * away that signal would defeat the entire point of the never-shed rule.
 */
export function buildOutgoingEnvelope(input: {
  mergedFolds: FoldDelta[];
  foldPriorityByFingerprint: ReadonlyMap<string, Priority>;
  exemplars: readonly PrioritizedExemplar[];
  meta: readonly DropCounters[];
  agentVersion: string;
}): Envelope {
  const items: EnvelopeItem[] = [];

  for (const delta of input.mergedFolds) {
    items.push({
      type: "fold",
      priority: input.foldPriorityByFingerprint.get(delta.fingerprint) ?? 3,
      payload: delta,
    });
  }
  for (const exemplar of input.exemplars) {
    items.push({ type: "exemplar", priority: exemplar.priority, payload: exemplar.payload });
  }
  items.push({ type: "meta", priority: 3, payload: mergeDropCounters(input.meta) });

  return { sentAt: new Date().toISOString(), sdkVersion: input.agentVersion, items };
}
