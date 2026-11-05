import type { Db, MongoClient } from "mongodb";
import { ensureIssuesIndexes } from "./collections/issues.js";
import { ensureIssueLinksIndexes } from "./collections/issue-links.js";
import { ensureEventsIndexes } from "./collections/events.js";
import { ensureDeploysIndexes } from "./collections/deploys.js";
import { ensureLogsIndexes, ensureRetentionIndex } from "./collections/logs.js";
import { DEFAULT_LOG_RETENTION_DAYS } from "@bugbusterhq/types";

/**
 * Resolves a `dbName` (already looked up via ControlDb — never a raw org name or API key) to a
 * `Db` handle scoped to exactly that database. This is the structural half of tenant isolation:
 * every collection call downstream operates on THIS handle, which is bound to one database name
 * and cannot be redirected to another — there is no shared-collection query path that a filter
 * could be forgotten from, because there is no shared collection.
 */
export class TenantDbResolver {
  private readonly ensuredIndexes = new Set<string>();

  private readonly logRetentionDays: number;

  constructor(
    private readonly client: MongoClient,
    options: { logRetentionDays?: number } = {},
  ) {
    this.logRetentionDays = options.logRetentionDays ?? DEFAULT_LOG_RETENTION_DAYS;
  }

  /** The retention that applies to an org: its own override, else the backend's default. */
  retentionFor(org: { logRetentionDays?: number }): number {
    return org.logRetentionDays ?? this.logRetentionDays;
  }

  /**
   * `org.logRetentionDays` is the org's own override (from its control record), when it has one.
   * Indexes are ensured once per database per process; a later retention change is applied
   * explicitly with applyLogRetention, which changes the TTL index for every process at once.
   */
  async forOrgDb(dbName: string, org: { logRetentionDays?: number } = {}): Promise<Db> {
    const db = this.client.db(dbName);
    if (!this.ensuredIndexes.has(dbName)) {
      await Promise.all([
        ensureIssuesIndexes(db),
        ensureIssueLinksIndexes(db),
        ensureEventsIndexes(db),
        ensureDeploysIndexes(db),
        ensureLogsIndexes(db, { retentionDays: this.retentionFor(org) }),
      ]);
      this.ensuredIndexes.add(dbName);
    }
    return db;
  }

  /** Applies an org's (new) retention to its logs TTL index now, for every backend process. */
  async applyLogRetention(dbName: string, org: { logRetentionDays?: number }): Promise<void> {
    const db = await this.forOrgDb(dbName, org);
    await ensureRetentionIndex(db, this.retentionFor(org));
  }
}
