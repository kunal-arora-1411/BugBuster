import { createHash } from "node:crypto";
import { MongoClient } from "mongodb";
import type { OrgRecord, ResolvedOrg } from "@bugbuster/types";

/**
 * The shared control database (ingest-pipeline.md §8.4). Resolves an API key to
 * `{ orgId, dbName }` BEFORE any tenant data is touched — this lookup, and the fact that no
 * tenant-scoped code runs before it completes, is the entire isolation mechanism.
 */
export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

export class ControlDb {
  private readonly client: MongoClient;

  constructor(uri: string) {
    this.client = new MongoClient(uri);
  }

  async connect(): Promise<void> {
    await this.client.connect();
    await this.orgs().createIndex({ apiKeyHash: 1 }, { unique: true });
    await this.orgs().createIndex({ orgId: 1 }, { unique: true });
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  /** Exposed so tenant.ts can share the same underlying MongoClient/connection pool. */
  getClient(): MongoClient {
    return this.client;
  }

  private orgs() {
    return this.client.db("bugbuster_control").collection<OrgRecord>("orgs");
  }

  async resolveApiKey(apiKey: string): Promise<ResolvedOrg | undefined> {
    const org = await this.orgs().findOne({ apiKeyHash: hashApiKey(apiKey) });
    return org ? { orgId: org.orgId, dbName: org.dbName } : undefined;
  }

  /** Admin/test helper — not part of the ingest or query request paths. */
  async createOrg(input: {
    orgId: string;
    name: string;
    dbName: string;
    apiKey: string;
  }): Promise<void> {
    await this.orgs().insertOne({
      orgId: input.orgId,
      name: input.name,
      dbName: input.dbName,
      apiKeyHash: hashApiKey(input.apiKey),
      createdAt: new Date().toISOString(),
    });
  }
}
