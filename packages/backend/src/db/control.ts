import { createHash } from "node:crypto";
import { MongoClient } from "mongodb";
import type { OrgRecord, ResolvedOrg } from "@bugbusterhq/types";

/**
 * The shared control database (ingest-pipeline.md §8.4). Resolves an API key to
 * `{ orgId, dbName }` BEFORE any tenant data is touched — this lookup, and the fact that no
 * tenant-scoped code runs before it completes, is the entire isolation mechanism.
 */
export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

/**
 * Retries a handful of times with a short backoff: Atlas TLS handshakes intermittently fail with
 * a transient "SSL alert internal error" (observed repeatedly in production against this cluster)
 * that reliably succeeds on the very next attempt. Uncaught, a failure here crashes the entire
 * process on a cold start (Node's default for a rejected top-level await) — on Vercel that means
 * one failed request per unlucky cold start, for a failure mode that isn't actually persistent.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  { attempts = 3, delayMs = 300 }: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw new Error("unreachable"); // satisfies the return type; the loop always returns or throws
}

export class ControlDb {
  private readonly client: MongoClient;

  constructor(uri: string) {
    this.client = new MongoClient(uri);
  }

  async connect(): Promise<void> {
    await retryWithBackoff(() => this.client.connect());
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
