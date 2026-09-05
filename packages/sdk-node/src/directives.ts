import type { Directives } from "@bugbuster/types";
import { SUPPRESSION_WINDOW_MS } from "@bugbuster/types";
import type { Sampler } from "./sampler.js";

/**
 * Per-fingerprint suppression (ingest-pipeline.md §7.1): once the backend holds enough samples of
 * a fingerprint, it says so by name, and the SDK sends counts-only (no exemplar payload) for that
 * fingerprint for the suppression window — possible only because fingerprinting is client-side.
 */
export class SuppressionState {
  private expiresAt = new Map<string, number>();

  applyList(fingerprints: readonly string[], now = Date.now()): void {
    for (const fp of fingerprints) {
      this.expiresAt.set(fp, now + SUPPRESSION_WINDOW_MS);
    }
  }

  isSuppressed(fingerprint: string, now = Date.now()): boolean {
    const exp = this.expiresAt.get(fingerprint);
    if (exp === undefined) return false;
    if (exp <= now) {
      this.expiresAt.delete(fingerprint);
      return false;
    }
    return true;
  }
}

/**
 * Applies a fully-parsed directive set to the SDK's in-process state. Shared by every Transport
 * implementation, since "stop generating, not just stop sending" must hold regardless of which
 * transport received the response.
 */
export function applyDirectives(
  directives: Directives,
  sampler: Sampler,
  suppression: SuppressionState,
): void {
  sampler.updateRates(directives.sample);
  suppression.applyList(directives.suppressFingerprints);
}
