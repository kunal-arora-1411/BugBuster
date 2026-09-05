import type { BugBusterEvent, FoldDelta } from "@bugbuster/types";

/**
 * The in-process fold table (ingest-pipeline.md §4). Groups occurrences by fingerprint within a
 * flush window and emits the RAW ingredients (`FoldDelta`) the backend needs to merge into the
 * persisted aggregate — not pre-computed percentiles or cardinality, which are only correct once
 * merged across every process that observed the fingerprint (§4.2's exact-for-v1 fields live in
 * @bugbuster/types `Issue`, not here).
 */

export interface FoldRecordInput {
  fingerprint: string;
  isNewFingerprint: boolean; // true only the first time this table has ever seen this fingerprint
  userId?: string;
  endpoint?: string;
  durationMs?: number;
  release?: string;
  event: BugBusterEvent; // exemplar candidate for this occurrence
}

interface FoldEntry {
  windowStart: string;
  count: number;
  userIds: Set<string>;
  endpointCounts: Map<string, number>;
  durationSamplesMs: number[];
  releases: Set<string>;
  firstEvent: BugBusterEvent;
  lastEvent: BugBusterEvent;
  slowestEvent: BugBusterEvent;
  slowestMs: number;
  novelStackEvent?: BugBusterEvent;
  perReleaseEvent: Map<string, BugBusterEvent>;
}

const MAX_EXEMPLARS_PER_ISSUE = 6;
const COARSENED_KEY = "__coarsened__";

export class FoldTable {
  private entries = new Map<string, FoldEntry>();

  constructor(private readonly maxLiveFingerprints: number) {}

  get liveFingerprintCount(): number {
    return this.entries.size;
  }

  record(input: FoldRecordInput): void {
    let key = input.fingerprint;

    // Cardinality cap (ingest-pipeline.md §4.5): a genuinely new fingerprint arriving once the
    // table is already at capacity is coarsened into a shared overflow bucket rather than
    // growing the table unbounded. Existing fingerprints already tracked keep updating normally.
    if (!this.entries.has(key) && this.entries.size >= this.maxLiveFingerprints) {
      key = COARSENED_KEY;
    }

    const existing = this.entries.get(key);
    if (!existing) {
      this.entries.set(key, {
        windowStart: new Date(input.event.timestamp).toISOString(),
        count: 1,
        userIds: new Set(input.userId ? [input.userId] : []),
        endpointCounts: new Map(input.endpoint ? [[input.endpoint, 1]] : []),
        durationSamplesMs: input.durationMs !== undefined ? [input.durationMs] : [],
        releases: new Set(input.release ? [input.release] : []),
        firstEvent: input.event,
        lastEvent: input.event,
        slowestEvent: input.event,
        slowestMs: input.durationMs ?? -Infinity,
        novelStackEvent: input.isNewFingerprint ? input.event : undefined,
        perReleaseEvent: new Map(input.release ? [[input.release, input.event]] : []),
      });
      return;
    }

    existing.count++;
    if (input.userId) existing.userIds.add(input.userId);
    if (input.endpoint) {
      existing.endpointCounts.set(
        input.endpoint,
        (existing.endpointCounts.get(input.endpoint) ?? 0) + 1,
      );
    }
    if (input.durationMs !== undefined) {
      existing.durationSamplesMs.push(input.durationMs);
      if (input.durationMs > existing.slowestMs) {
        existing.slowestMs = input.durationMs;
        existing.slowestEvent = input.event;
      }
    }
    if (input.release) {
      existing.releases.add(input.release);
      if (!existing.perReleaseEvent.has(input.release)) {
        existing.perReleaseEvent.set(input.release, input.event);
      }
    }
    existing.lastEvent = input.event;
  }

  /** Selects exemplars for one entry, priority-ordered, capped at MAX_EXEMPLARS_PER_ISSUE. */
  private selectExemplars(entry: FoldEntry): BugBusterEvent[] {
    const seen = new Set<string>();
    const selected: BugBusterEvent[] = [];
    const push = (evt: BugBusterEvent | undefined) => {
      if (!evt || seen.has(evt.eventId) || selected.length >= MAX_EXEMPLARS_PER_ISSUE) return;
      seen.add(evt.eventId);
      selected.push(evt);
    };
    push(entry.novelStackEvent);
    push(entry.firstEvent);
    push(entry.lastEvent);
    push(entry.slowestEvent);
    for (const evt of entry.perReleaseEvent.values()) push(evt);
    return selected;
  }

  /** Drains the current window into wire-ready deltas + the exemplar payloads they reference. */
  drain(): { deltas: FoldDelta[]; exemplars: BugBusterEvent[] } {
    const deltas: FoldDelta[] = [];
    const exemplars: BugBusterEvent[] = [];
    const windowEnd = new Date().toISOString();

    for (const [key, entry] of this.entries) {
      const selectedExemplars = this.selectExemplars(entry);
      exemplars.push(
        ...selectedExemplars.map((evt) => ({ ...evt, exemplarRole: roleFor(evt, entry) })),
      );

      deltas.push({
        fingerprint: key,
        windowStart: entry.windowStart,
        windowEnd,
        count: entry.count,
        userIds: [...entry.userIds],
        endpointCounts: Object.fromEntries(entry.endpointCounts),
        durationSamplesMs: entry.durationSamplesMs,
        release: [...entry.releases][0],
        exemplars: selectedExemplars.map((e) => e.eventId),
      });
    }

    this.entries.clear();
    return { deltas, exemplars };
  }
}

function roleFor(evt: BugBusterEvent, entry: FoldEntry): BugBusterEvent["exemplarRole"] {
  if (entry.novelStackEvent?.eventId === evt.eventId) return "one-novel-stack";
  if (entry.firstEvent.eventId === evt.eventId) return "first";
  if (entry.lastEvent.eventId === evt.eventId) return "last";
  if (entry.slowestEvent.eventId === evt.eventId) return "slowest";
  return "one-per-release";
}

export { COARSENED_KEY, MAX_EXEMPLARS_PER_ISSUE };
