import type {
  BugBusterEvent,
  DropCounters,
  Envelope,
  EnvelopeItem,
  FoldDelta,
} from "@bugbuster/types";
import { encodeEnvelope, NEVER_SHED_PRIORITIES } from "@bugbuster/types";

/**
 * Builds the typed Envelope from one flush cycle's fold deltas, exemplars, and drop-counter meta.
 * No compression happens here: compression is the Agent's job (ingest-pipeline.md §6.2 — the SDK's
 * entire job is "serialize, write to a Unix domain socket, forget"), not the SDK's. The actual
 * wire encoding (encodeEnvelope/decodeEnvelopeItems) lives in @bugbuster/types as the shared codec
 * every side of the transport uses — see packages/types/src/codec.ts.
 */
export function buildEnvelope(input: {
  deltas: FoldDelta[];
  exemplars: BugBusterEvent[];
  meta: DropCounters;
  sdkVersion: string;
  newFingerprints: ReadonlySet<string>;
  /** Fingerprints currently suppressed (§7.1) — their exemplars are dropped, counts are kept. */
  isSuppressed?: (fingerprint: string) => boolean;
}): Envelope {
  const items: EnvelopeItem[] = [];
  const suppressed = input.isSuppressed ?? (() => false);

  for (const delta of input.deltas) {
    items.push({
      type: "fold",
      priority: input.newFingerprints.has(delta.fingerprint) ? 9 : 3,
      payload: delta,
    });
  }

  for (const exemplar of input.exemplars) {
    if (suppressed(exemplar.fingerprint)) continue; // counts-only for this fingerprint right now
    const isNewFingerprint = input.newFingerprints.has(exemplar.fingerprint);
    const is5xx = exemplar.error?.code?.startsWith("5") ?? false;
    items.push({
      type: "exemplar",
      priority: isNewFingerprint || is5xx ? 9 : 2,
      payload: exemplar,
    });
  }

  items.push({ type: "meta", priority: 3, payload: input.meta });

  return { sentAt: new Date().toISOString(), sdkVersion: input.sdkVersion, items };
}

export { encodeEnvelope, NEVER_SHED_PRIORITIES };
