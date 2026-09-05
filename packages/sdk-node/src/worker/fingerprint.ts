import { createHash } from "node:crypto";
import type { StackFrame } from "./stack.js";

/**
 * `fingerprint = SHA256(exception_type + normalized_stack + function)` — doc.md's original
 * proposal, adopted as-is. Stable across two calls on byte-identical input (required for grouping
 * to work at all), and stable across superficial differences (timestamps, request IDs) because
 * those never enter the hashed material in the first place.
 */

/**
 * Strips exactly the parts of a frame that change between otherwise-identical occurrences of the
 * same bug (nothing here — line/column are KEPT, deliberately: two different lines in the same
 * function are, structurally, different bugs until proven otherwise. What's normalized is the
 * file path, so the same source file built into two different deploy paths still collides.
 */
function normalizeFrame(frame: StackFrame): string {
  const normalizedFile = frame.file.replace(/^.*[/\\]/, ""); // basename only
  return `${frame.function}@${normalizedFile}:${frame.line}`;
}

export function normalizeStack(frames: StackFrame[]): string {
  return frames.map(normalizeFrame).join("|");
}

export interface FingerprintInput {
  errorType: string;
  frames: StackFrame[];
}

/**
 * How many frames from the throw site are hashed by default. This is not an arbitrary limit —
 * frames ABOVE this depth are caller context (which request handler, which async scheduling path
 * called into the function that threw), and two occurrences of the identical bug legitimately
 * arrive with different, unrelated caller chains above them. Hashing the entire stack would treat
 * "same bug, different caller" as different bugs, which is the same over-fragmentation problem
 * §4.5's coarsening exists to fix — just triggered by caller-depth instead of cardinality
 * pressure. Ten frames is enough to capture the actual call path inside the failing subsystem
 * while dropping generic framework/runtime frames above it.
 */
const DEFAULT_FINGERPRINT_DEPTH = 10;

/** The primary entry point at a given (uncoarsened) stack depth. */
function primaryFunction(frames: StackFrame[]): string {
  return frames[0]?.function ?? "<unknown>";
}

export function computeFingerprint(input: FingerprintInput): string {
  return computeFingerprintAtDepth(input, DEFAULT_FINGERPRINT_DEPTH);
}

function computeFingerprintAtDepth(input: FingerprintInput, depth: number): string {
  // In-app frames only (stack.ts's isInAppFrame) — Node runtime internals and event-loop
  // resumption frames above them are not part of the application's call path and are, after an
  // `await`, genuinely nondeterministic from one occurrence of the identical bug to the next.
  // Falls back to the raw frames only if filtering somehow removes everything (a stack that is
  // 100% runtime internals means there's nothing else to fingerprint on).
  const inAppFrames = input.frames.filter((f) => f.inApp);
  const candidateFrames = inAppFrames.length > 0 ? inAppFrames : input.frames;

  const frames = candidateFrames.slice(0, Math.max(depth, 1));
  const normalizedStack = normalizeStack(frames);
  const material = `${input.errorType}::${normalizedStack}::${primaryFunction(frames)}`;
  return `fp_${createHash("sha256").update(material).digest("hex").slice(0, 16)}`;
}

/**
 * Coarsening (ingest-pipeline.md §4.5): strips MORE trailing frames than the default depth so
 * more distinct-but-related errors collide into one fingerprint under cardinality pressure.
 * `depth` frames are kept, deepest (closest to the throw site) first.
 */
export function computeCoarsenedFingerprint(input: FingerprintInput, depth: number): string {
  return computeFingerprintAtDepth(input, depth);
}
