import type { ResolvedOrg } from "@bugbuster/types";
import type { ControlDb } from "../db/control.js";

/**
 * The cheap gate (ingest-pipeline.md §8.1/§8.3). Resolves auth against the CONTROL database only
 * — no tenant data is touched here — and does it from an in-memory cache after the first lookup,
 * so a steady stream of requests from the same org never re-hits Mongo for auth.
 *
 * v1 nuance, stated plainly (see the implementation plan's M4 notes and
 * docs/architecture/ingest-pipeline.md §8.1): the full "never parses the body" guarantee assumes a
 * separate processing tier the edge can hand raw bytes to. v1 has no such tier — ingest and
 * processing run in the same process — so this module's job is narrowed to what it CAN do without
 * parsing: authenticate, and enforce the request size limit (via Fastify's `bodyLimit`, configured
 * where the route is registered, not here). Priority-based shedding requires reading the envelope
 * items, which is `processor.ts`'s job, alongside the JSON parse it already has no way to avoid.
 */
const orgCacheByApiKey = new Map<string, ResolvedOrg>();

export async function resolveOrgForRequest(
  apiKey: string,
  controlDb: ControlDb,
): Promise<ResolvedOrg | undefined> {
  const cached = orgCacheByApiKey.get(apiKey);
  if (cached) return cached;

  const resolved = await controlDb.resolveApiKey(apiKey);
  if (resolved) orgCacheByApiKey.set(apiKey, resolved);
  return resolved;
}

/** Test-only: clears the process-local auth cache between isolated test runs. */
export function _resetOrgCacheForTests(): void {
  orgCacheByApiKey.clear();
}

export function extractBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader?.startsWith("Bearer ")) return undefined;
  return authorizationHeader.slice("Bearer ".length).trim() || undefined;
}
