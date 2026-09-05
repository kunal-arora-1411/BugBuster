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
  apiKeyHash: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type OrgRecord = z.infer<typeof OrgRecordSchema>;

/**
 * What a successful API-key resolution produces — passed from packages/backend/src/db/control.ts
 * to everything downstream in the request. Deliberately does NOT carry the raw API key or the
 * hash; only what's needed to open the org's own database connection.
 */
export const ResolvedOrgSchema = z.object({
  orgId: z.string().min(1),
  dbName: z.string().min(1),
});
export type ResolvedOrg = z.infer<typeof ResolvedOrgSchema>;
