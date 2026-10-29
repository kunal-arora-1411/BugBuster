import type { Envelope, EnvelopeItem } from "./envelope.js";

/**
 * Envelope wire codec — shared by every side that reads or writes the NDJSON transport format
 * (SDK -\> Agent over UDS, Agent -\> backend over HTTPS), so there is exactly one implementation
 * of "what a frame boundary is" in the whole system.
 *
 * Frames as newline-delimited JSON — one complete item per line (ingest-pipeline.md §6.5's
 * "newline-delimited, length-prefixed items" requirement, satisfied without an explicit length
 * prefix: JSON.stringify escapes embedded newlines, so a line boundary is always an item
 * boundary, and a stream cut mid-item simply drops that incomplete final line while every prior
 * line remains independently parseable).
 */
export function encodeEnvelope(envelope: Envelope): Buffer {
  const lines = envelope.items.map((item) => JSON.stringify(item));
  return Buffer.from(lines.join("\n") + (lines.length > 0 ? "\n" : ""), "utf8");
}

/** Decodes a (possibly truncated) NDJSON buffer back into whole items, dropping any partial tail. */
export function decodeEnvelopeItems(buf: Buffer): EnvelopeItem[] {
  const text = buf.toString("utf8");
  const lines = text.split("\n").filter((l) => l.length > 0);
  const items: EnvelopeItem[] = [];
  for (const line of lines) {
    try {
      items.push(JSON.parse(line) as EnvelopeItem);
    } catch {
      // an incomplete final line, or corrupt input from an untrusted sender — drop it, never
      // throw: this is read at process boundaries (Agent reading from the SDK, backend reading
      // from the Agent) that must not be crashable by malformed input.
    }
  }
  return items;
}

/**
 * Splits items into batches whose serialized size stays at or under `maxBytes` (each item measured
 * as its JSON length plus a small per-item framing overhead). An item that is by itself larger
 * than `maxBytes` still gets a batch of its own — this function never drops anything; deciding
 * what is too large to accept is the receiver's job.
 *
 * Shared by the SDK and the Agent because both must keep every outbound POST under the backend's
 * request-size limit: one oversize request is rejected whole (413), losing every item in it.
 */
export function splitIntoBatches<T>(items: readonly T[], maxBytes: number): T[][] {
  const FRAMING_OVERHEAD_BYTES = 64; // the `{"type":"log","priority":N,"payload":...}` wrapper
  const batches: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const item of items) {
    const bytes = Buffer.byteLength(JSON.stringify(item), "utf8") + FRAMING_OVERHEAD_BYTES;
    if (current.length > 0 && currentBytes + bytes > maxBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
