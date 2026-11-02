import type { ResolvedOrg } from "@bugbusterhq/types";
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
const orgCacheByApiKey = new Map<string, { org: ResolvedOrg; at: number }>();

/**
 * How long a resolved key is trusted without asking the control database again. This bounds how
 * long a revoked key, or a disabled org, keeps working on a backend instance that did not make the
 * change (on Vercel there are several): at most a minute. The instance that makes the change
 * forgets the org at once (forgetOrg). The cost is one control lookup per key per minute.
 */
export const AUTH_CACHE_TTL_MS = 60_000;
/** Key use is recorded at most this often per key, so it is not a database write per request. */
const KEY_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const lastTouched = new Map<string, number>();

export async function resolveOrgForRequest(
  apiKey: string,
  controlDb: ControlDb,
): Promise<ResolvedOrg | undefined> {
  const now = Date.now();
  const cached = orgCacheByApiKey.get(apiKey);
  if (cached && now - cached.at < AUTH_CACHE_TTL_MS) return cached.org;

  const resolved = await controlDb.resolveApiKey(apiKey);
  if (resolved) orgCacheByApiKey.set(apiKey, { org: resolved, at: now });
  else orgCacheByApiKey.delete(apiKey);
  return resolved;
}

/** Records that a key was used ("last used" in the admin page), throttled; never throws. */
export function noteKeyUse(org: ResolvedOrg, controlDb: ControlDb): void {
  if (!org.keyId) return;
  const now = Date.now();
  if (now - (lastTouched.get(org.keyId) ?? 0) < KEY_TOUCH_INTERVAL_MS) return;
  lastTouched.set(org.keyId, now);
  controlDb.touchKey(org.keyId, new Date(now)).catch(() => lastTouched.delete(org.keyId as string));
}

/**
 * Drops this process's cached resolutions for an org after an admin change (revoked key,
 * disabled org, new retention), so the next request reads the control record again.
 */
export function forgetOrg(orgId: string): void {
  for (const [key, entry] of orgCacheByApiKey) {
    if (entry.org.orgId === orgId) orgCacheByApiKey.delete(key);
  }
}

/** Test-only: clears the process-local auth cache between isolated test runs. */
export function _resetOrgCacheForTests(): void {
  orgCacheByApiKey.clear();
  lastTouched.clear();
}

export function extractBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader?.startsWith("Bearer ")) return undefined;
  return authorizationHeader.slice("Bearer ".length).trim() || undefined;
}
