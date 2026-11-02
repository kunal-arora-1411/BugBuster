import { z } from "zod";

/**
 * The control-plane record for one organization (ingest-pipeline.md §8.4) — lives in the shared
 * `bugbuster_control` database. `dbName` is what makes tenant isolation structural rather than a
 * filter: the ingest edge resolves this BEFORE touching any tenant data, then opens a connection
 * scoped to exactly that database for the rest of the request.
 */
export const OrgRecordSchema = z.object({
  orgId: z.string().min(1),
  name: z.string().min(1),
  dbName: z.string().min(1),
  /**
   * Legacy: the org's single key, from before orgs had named keys (`ApiKeyRecord`). Copied into the
   * keys collection at startup and only kept so backends still running the old code during a
   * rolling deploy keep accepting it; removed when that key is revoked.
   */
  apiKeyHash: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  /**
   * This org's log retention in days, overriding the backend's BUGBUSTER_LOG_RETENTION_DAYS.
   * Absent = the backend default; 0 = keep forever.
   */
  logRetentionDays: z.number().int().nonnegative().optional(),
  /** A disabled org's keys are refused (403) for sending and reading. Its data is kept. */
  disabled: z.boolean().optional(),
  disabledAt: z.string().datetime().optional(),
});
export type OrgRecord = z.infer<typeof OrgRecordSchema>;

/**
 * One API key of an org. An org has any number of them (one per service or person), each revoked
 * on its own. Only the SHA-256 of the key is stored; the key itself is shown once, at creation.
 */
export const ApiKeyRecordSchema = z.object({
  keyId: z.string().min(1),
  orgId: z.string().min(1),
  name: z.string().min(1),
  keyHash: z.string().min(1),
  createdAt: z.string().datetime(),
  /** Updated at most about once an hour per key, so it is not a write on every request. */
  lastUsedAt: z.string().datetime().optional(),
  revokedAt: z.string().datetime().optional(),
});
export type ApiKeyRecord = z.infer<typeof ApiKeyRecordSchema>;

/**
 * What a successful API-key resolution produces — passed from packages/backend/src/db/control.ts
 * to everything downstream in the request. Deliberately does NOT carry the raw API key or the
 * hash; only what's needed to open the org's own database connection.
 */
export const ResolvedOrgSchema = z.object({
  orgId: z.string().min(1),
  dbName: z.string().min(1),
  /** Only when the org overrides the backend's default retention. */
  logRetentionDays: z.number().int().nonnegative().optional(),
  /** Set when the org is disabled: the request is refused before any tenant data is touched. */
  disabled: z.boolean().optional(),
  /** Which of the org's keys authenticated the request. */
  keyId: z.string().min(1).optional(),
});
export type ResolvedOrg = z.infer<typeof ResolvedOrgSchema>;
