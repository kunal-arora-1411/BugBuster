import type { Db, MongoClient } from "mongodb";
import { ensureIssuesIndexes } from "./collections/issues.js";
import { ensureEventsIndexes } from "./collections/events.js";
import { ensureDeploysIndexes } from "./collections/deploys.js";

/**
 * Resolves a `dbName` (already looked up via ControlDb — never a raw org name or API key) to a
 * `Db` handle scoped to exactly that database. This is the structural half of tenant isolation:
 * every collection call downstream operates on THIS handle, which is bound to one database name
 * and cannot be redirected to another — there is no shared-collection query path that a filter
 * could be forgotten from, because there is no shared collection.
 */
export class TenantDbResolver {
  private readonly ensuredIndexes = new Set<string>();

  constructor(private readonly client: MongoClient) {}

  async forOrgDb(dbName: string): Promise<Db> {
    const db = this.client.db(dbName);
    if (!this.ensuredIndexes.has(dbName)) {
      await Promise.all([
        ensureIssuesIndexes(db),
        ensureEventsIndexes(db),
        ensureDeploysIndexes(db),
      ]);
      this.ensuredIndexes.add(dbName);
    }
    return db;
  }
}
