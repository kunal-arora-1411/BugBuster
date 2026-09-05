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
