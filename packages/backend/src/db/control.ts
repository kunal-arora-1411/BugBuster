import { createHash, randomBytes } from "node:crypto";
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

  /**
   * Creates an org with a freshly generated API key and returns that key — the only time it is
   * ever available in plain text (only its hash is stored). The org's database is derived from
   * its id, and refused if ANY existing org already uses it: two orgs sharing a database would
   * break tenant isolation, and orgs created by the CLI choose their database name freely.
   *
   * The existence check and the insert are not atomic. That is acceptable for an operation only
   * an operator holding the admin token can call; the unique `orgId` index still rejects the
   * same id raced twice.
   */
  async createOrgWithGeneratedKey(input: {
    orgId: string;
    name: string;
  }): Promise<
    | { created: true; orgId: string; name: string; dbName: string; apiKey: string }
    | { created: false }
  > {
    const dbName = `bugbuster_org_${input.orgId}`;
    if (await this.orgs().findOne({ $or: [{ orgId: input.orgId }, { dbName }] })) {
      return { created: false };
    }
    const apiKey = `bb_${randomBytes(32).toString("base64url")}`;
    try {
      await this.createOrg({ orgId: input.orgId, name: input.name, dbName, apiKey });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return { created: false };
      throw err;
    }
    return { created: true, orgId: input.orgId, name: input.name, dbName, apiKey };
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
