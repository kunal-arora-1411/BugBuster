import { createHash, randomBytes } from "node:crypto";
import { MongoClient } from "mongodb";
import type { ApiKeyRecord, OrgAlerts, OrgRecord, ResolvedOrg } from "@bugbusterhq/types";

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

/** An org as the admin surface sees it: never its legacy key hash. */
export type PublicOrg = Omit<OrgRecord, "apiKeyHash">;
/** A key as the admin surface sees it: never its hash. */
export type PublicKey = Omit<ApiKeyRecord, "keyHash">;

export interface AdminEvent {
  at: string;
  action: string;
  orgId?: string;
  detail?: string;
}

const DUPLICATE_KEY = 11000;
const newApiKey = () => `bb_${randomBytes(32).toString("base64url")}`;
const newKeyId = () => `key_${randomBytes(6).toString("hex")}`;

export class ControlDb {
  private readonly client: MongoClient;

  constructor(uri: string) {
    this.client = new MongoClient(uri);
  }

  async connect(): Promise<void> {
    await retryWithBackoff(() => this.client.connect());
    await this.orgs().createIndex({ orgId: 1 }, { unique: true });
    await this.keys().createIndex({ keyHash: 1 }, { unique: true });
    await this.keys().createIndex({ orgId: 1, createdAt: 1 });
    await this.adminEvents().createIndex({ at: -1 });
    await this.migrateLegacyKeys();
  }

  /**
   * Orgs created before named keys carry their one key's hash on the org record. Copy each into
   * the keys collection as "Original key" so it keeps working and can be revoked like any other.
   * Idempotent (the unique keyHash index makes a second copy a no-op) and safe when several
   * instances start at once.
   *
   * The org's own `apiKeyHash` is deliberately left in place: during a rolling deploy, backends
   * still running the previous code authenticate with it. It is removed when that key is revoked.
   * Its old unique index is dropped, because orgs created from now on have no such field, and a
   * unique index would let only one of them exist.
   */
  private async migrateLegacyKeys(): Promise<void> {
    const indexes = await this.orgs().listIndexes().toArray();
    if (indexes.some((i) => i.name === "apiKeyHash_1")) {
      await this.orgs()
        .dropIndex("apiKeyHash_1")
        .catch(() => {}); // another instance dropped it first
    }
    const legacy = await this.orgs()
      .find(
        { apiKeyHash: { $exists: true } },
        { projection: { orgId: 1, apiKeyHash: 1, createdAt: 1 } },
      )
      .toArray();
    for (const org of legacy) {
      if (!org.apiKeyHash) continue;
      try {
        await this.keys().insertOne({
          keyId: newKeyId(),
          orgId: org.orgId,
          name: "Original key",
          keyHash: org.apiKeyHash,
          createdAt: org.createdAt,
        });
      } catch (err) {
        if ((err as { code?: number }).code !== DUPLICATE_KEY) throw err;
      }
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  /** Exposed so tenant.ts can share the same underlying MongoClient/connection pool. */
  getClient(): MongoClient {
    return this.client;
  }

  private control() {
    return this.client.db("bugbuster_control");
  }
  private orgs() {
    return this.control().collection<OrgRecord>("orgs");
  }
  private keys() {
    return this.control().collection<ApiKeyRecord>("keys");
  }
  private adminEvents() {
    return this.control().collection<AdminEvent>("admin_events");
  }

  async resolveApiKey(apiKey: string): Promise<ResolvedOrg | undefined> {
    const key = await this.keys().findOne(
      { keyHash: hashApiKey(apiKey), revokedAt: { $exists: false } },
      { projection: { keyId: 1, orgId: 1 } },
    );
    if (!key) return undefined;
    const org = await this.orgs().findOne({ orgId: key.orgId });
    if (!org) return undefined;
    return {
      orgId: org.orgId,
      dbName: org.dbName,
      keyId: key.keyId,
      ...(org.logRetentionDays !== undefined ? { logRetentionDays: org.logRetentionDays } : {}),
      ...(org.disabled ? { disabled: true } : {}),
    };
  }

  /** Records that a key was used. The caller throttles it; see ingest/edge.ts. */
  async touchKey(keyId: string, at = new Date()): Promise<void> {
    await this.keys().updateOne({ keyId }, { $set: { lastUsedAt: at.toISOString() } });
  }

  /** Every org, without its key hash. For operator tooling, never for tenant request paths. */
  async listOrgs(): Promise<PublicOrg[]> {
    return this.orgs()
      .find({}, { projection: { _id: 0, apiKeyHash: 0 } })
      .sort({ orgId: 1 })
      .toArray();
  }

  async getOrg(orgId: string): Promise<PublicOrg | undefined> {
    return (
      (await this.orgs().findOne({ orgId }, { projection: { _id: 0, apiKeyHash: 0 } })) ?? undefined
    );
  }

  /** An org's keys (or every org's), oldest first, without their hashes. */
  async listKeys(orgId?: string): Promise<PublicKey[]> {
    return this.keys()
      .find(orgId ? { orgId } : {}, { projection: { _id: 0, keyHash: 0 } })
      .sort({ orgId: 1, createdAt: 1 })
      .toArray();
  }

  /**
   * Changes an org's name, log retention (a number of days, or null for the backend default) or
   * disabled state. Returns the org as stored afterwards, or undefined when there is no such org.
   */
  async updateOrg(
    orgId: string,
    change: { name?: string; logRetentionDays?: number | null; disabled?: boolean },
  ): Promise<PublicOrg | undefined> {
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, ""> = {};
    if (change.name !== undefined) $set.name = change.name;
    if (change.logRetentionDays === null) $unset.logRetentionDays = "";
    else if (change.logRetentionDays !== undefined) $set.logRetentionDays = change.logRetentionDays;
    if (change.disabled === true) {
      $set.disabled = true;
      $set.disabledAt = new Date().toISOString();
    } else if (change.disabled === false) {
      $unset.disabled = "";
      $unset.disabledAt = "";
    }
    const update = {
      ...(Object.keys($set).length ? { $set } : {}),
      ...(Object.keys($unset).length ? { $unset } : {}),
    };
    if (Object.keys(update).length === 0) return this.getOrg(orgId);
    const org = await this.orgs().findOneAndUpdate({ orgId }, update, {
      returnDocument: "after",
      projection: { _id: 0, apiKeyHash: 0 },
    });
    return org ?? undefined;
  }

  /**
   * Saves an org's email alert settings. Switching alerts on (from off, or for the first time)
   * restarts `since`, so issues that appeared while they were off are not all sent at once.
   */
  async setAlerts(
    orgId: string,
    alerts: Omit<OrgAlerts, "since">,
    now = new Date(),
  ): Promise<PublicOrg | undefined> {
    const current = await this.orgs().findOne({ orgId }, { projection: { alerts: 1 } });
    if (!current) return undefined;
    const turnedOn = alerts.enabled && !current.alerts?.enabled;
    const since = turnedOn || !current.alerts ? now.toISOString() : current.alerts.since;
    const org = await this.orgs().findOneAndUpdate(
      { orgId },
      { $set: { alerts: { ...alerts, since } } },
      { returnDocument: "after", projection: { _id: 0, apiKeyHash: 0 } },
    );
    return org ?? undefined;
  }

  /** Orgs whose alerts are switched on and have someone to send to. */
  async listOrgsWithAlerts(): Promise<PublicOrg[]> {
    return this.orgs()
      .find(
        {
          "alerts.enabled": true,
          "alerts.recipients.0": { $exists: true },
          disabled: { $ne: true },
        },
        { projection: { _id: 0, apiKeyHash: 0 } },
      )
      .toArray();
  }

  /**
   * Takes the right to send this org's alerts for `leaseMs`, if no other process holds it. One
   * conditional update, so two processes can never both get it. Undefined when it is held.
   */
  async claimAlertLease(
    orgId: string,
    leaseMs: number,
    now = new Date(),
  ): Promise<PublicOrg | undefined> {
    const org = await this.orgs().findOneAndUpdate(
      {
        orgId,
        $or: [
          { "alertState.leaseUntil": { $exists: false } },
          { "alertState.leaseUntil": { $lt: now.toISOString() } },
        ],
      },
      { $set: { "alertState.leaseUntil": new Date(now.getTime() + leaseMs).toISOString() } },
      { returnDocument: "after", projection: { _id: 0, apiKeyHash: 0 } },
    );
    return org ?? undefined;
  }

  /**
   * Ends a send: releases the lease and records what happened. `sentAt` is the new list of sends
   * within the last hour (the caller drops older ones); `error` is set when the send failed.
   */
  async finishAlertRun(
    orgId: string,
    result: { sentAt: string[]; sent: boolean; error?: string },
    now = new Date(),
  ): Promise<void> {
    const at = now.toISOString();
    const $set: Record<string, unknown> = { "alertState.sentAt": result.sentAt };
    const $unset: Record<string, ""> = { "alertState.leaseUntil": "" };
    if (result.error !== undefined) {
      $set["alertState.lastError"] = result.error;
      $set["alertState.lastErrorAt"] = at;
    } else if (result.sent) {
      $set["alertState.lastSentAt"] = at;
      $unset["alertState.lastError"] = "";
      $unset["alertState.lastErrorAt"] = "";
    }
    await this.orgs().updateOne({ orgId }, { $set, $unset });
  }

  /** Back-compat wrapper: sets or clears (null) an org's log retention. */
  async setLogRetention(
    orgId: string,
    logRetentionDays: number | null,
  ): Promise<PublicOrg | undefined> {
    return this.updateOrg(orgId, { logRetentionDays });
  }

  /**
   * Creates a new key for an org and returns it in plain text: the only time it is ever
   * available (only its hash is stored). Undefined when there is no such org.
   */
  async createKey(
    orgId: string,
    name: string,
  ): Promise<(PublicKey & { apiKey: string }) | undefined> {
    if (!(await this.orgs().findOne({ orgId }, { projection: { _id: 1 } }))) return undefined;
    const apiKey = newApiKey();
    const key: ApiKeyRecord = {
      keyId: newKeyId(),
      orgId,
      name,
      keyHash: hashApiKey(apiKey),
      createdAt: new Date().toISOString(),
    };
    await this.keys().insertOne({ ...key });
    const { keyHash: _hash, ...rest } = key;
    return { ...rest, apiKey };
  }

  /**
   * Revokes one key; the org's other keys keep working. Revoking is recorded rather than deleting
   * the key, so the list still shows what it was and when it stopped. Revoking twice is a no-op.
   * Undefined when the org has no such key.
   */
  async revokeKey(orgId: string, keyId: string): Promise<PublicKey | undefined> {
    const key = await this.keys().findOne({ orgId, keyId });
    if (!key) return undefined;
    if (!key.revokedAt) {
      await this.keys().updateOne(
        { keyId, revokedAt: { $exists: false } },
        { $set: { revokedAt: new Date().toISOString() } },
      );
      // A migrated original key is also still on the org record for old backends; remove it there.
      await this.orgs().updateOne(
        { orgId, apiKeyHash: key.keyHash },
        { $unset: { apiKeyHash: "" } },
      );
    }
    return (
      (await this.keys().findOne({ keyId }, { projection: { _id: 0, keyHash: 0 } })) ?? undefined
    );
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
    logRetentionDays?: number;
    keyName?: string;
  }): Promise<
    | {
        created: true;
        orgId: string;
        name: string;
        dbName: string;
        apiKey: string;
        keyId: string;
        logRetentionDays?: number;
      }
    | { created: false }
  > {
    const dbName = `bugbuster_org_${input.orgId}`;
    if (await this.orgs().findOne({ $or: [{ orgId: input.orgId }, { dbName }] })) {
      return { created: false };
    }
    const apiKey = newApiKey();
    let keyId: string;
    try {
      keyId = await this.createOrg({
        orgId: input.orgId,
        name: input.name,
        dbName,
        apiKey,
        keyName: input.keyName,
        logRetentionDays: input.logRetentionDays,
      });
    } catch (err) {
      if ((err as { code?: number }).code === DUPLICATE_KEY) return { created: false };
      throw err;
    }
    return {
      created: true,
      orgId: input.orgId,
      name: input.name,
      dbName,
      apiKey,
      keyId,
      ...(input.logRetentionDays !== undefined ? { logRetentionDays: input.logRetentionDays } : {}),
    };
  }

  /** Creates an org and its first key from a given API key. Admin/test helper. Returns the keyId. */
  async createOrg(input: {
    orgId: string;
    name: string;
    dbName: string;
    apiKey: string;
    keyName?: string;
    logRetentionDays?: number;
  }): Promise<string> {
    const createdAt = new Date().toISOString();
    await this.orgs().insertOne({
      orgId: input.orgId,
      name: input.name,
      dbName: input.dbName,
      createdAt,
      ...(input.logRetentionDays !== undefined ? { logRetentionDays: input.logRetentionDays } : {}),
    });
    const keyId = newKeyId();
    await this.keys().insertOne({
      keyId,
      orgId: input.orgId,
      name: input.keyName ?? "Default key",
      keyHash: hashApiKey(input.apiKey),
      createdAt,
    });
    return keyId;
  }

  /** Appends to the admin change history. Best-effort: a failure here never fails the change. */
  async recordAdminEvent(event: Omit<AdminEvent, "at">): Promise<void> {
    await this.adminEvents()
      .insertOne({ at: new Date().toISOString(), ...event })
      .catch(() => {});
  }

  async listAdminEvents(limit: number): Promise<AdminEvent[]> {
    return this.adminEvents()
      .find({}, { projection: { _id: 0 } })
      .sort({ at: -1, _id: -1 }) // _id breaks ties between changes in the same millisecond
      .limit(limit)
      .toArray();
  }
}
