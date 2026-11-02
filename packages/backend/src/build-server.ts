import { createHash, timingSafeEqual } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { BackendConfig, ResolvedOrg } from "@bugbusterhq/types";
import {
  HEADER_CONFIG_VERSION,
  HEADER_RETRY_AFTER,
  HEADER_SAMPLE_DIRECTIVE,
  HEADER_SUPPRESS_FINGERPRINTS,
  LogLevelSchema,
  type LogLevel,
} from "@bugbusterhq/types";
import type { ControlDb, PublicKey, PublicOrg } from "./db/control.js";
import { TenantDbResolver } from "./db/tenant.js";
import { extractBearerToken, forgetOrg, noteKeyUse, resolveOrgForRequest } from "./ingest/edge.js";
import { processEnvelope } from "./ingest/processor.js";
import { decodeIssuesCursor, getIssue, listIssues } from "./db/collections/issues.js";
import { getExemplarsByIds } from "./db/collections/events.js";
import { decodeLogsCursor, getLogFacets, queryLogs, type LogQuery } from "./db/collections/logs.js";
import { attachFidelity } from "./query/fidelity.js";
import { orgStorageReport } from "./db/storage-report.js";
import { countUnreferencedEvents, deleteUnreferencedEvents } from "./db/maintenance.js";
import { ADMIN_PAGE_HTML } from "./admin-page.js";
import { computeDirectives } from "./directives.js";
import { buildOpenApiDocument, SWAGGER_UI_HTML } from "./openapi.js";

const CONFIG_VERSION = 1;
const DEFAULT_ISSUES_LIMIT = 50;
const MAX_ISSUES_LIMIT = 200;
const DEFAULT_LOGS_LIMIT = 100;
const MAX_LOGS_LIMIT = 500;
const FACETS_CACHE_MS = 60_000;
/** An org id becomes part of a MongoDB database name, so it is kept to a safe, short alphabet. */
const ORG_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MAX_ORG_NAME_CHARS = 200;
const MAX_KEY_NAME_CHARS = 100;
const MAX_RETENTION_DAYS = 3650;

/** A trimmed name of 1..max characters, or undefined when it is not one. */
function parseName(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  return name.length > 0 && name.length <= max ? name : undefined;
}
const RETENTION_ERROR = `logRetentionDays must be a whole number from 0 (keep forever) to ${MAX_RETENTION_DAYS}`;

/** undefined when absent, null when explicitly cleared (if allowed), "invalid" otherwise wrong. */
function parseRetentionDays(
  value: unknown,
  opts: { allowNull: boolean },
): number | null | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (value === null) return opts.allowNull ? null : "invalid";
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_RETENTION_DAYS
    ? value
    : "invalid";
}

/** Constant-time comparison (hashing first makes the lengths equal, as timingSafeEqual needs). */
function tokensMatch(given: string, expected: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/** A query-string value is a string only if the caller sent exactly one; repeats arrive as arrays. */
function singleString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Parses/validates `GET /logs` query parameters. Returns either a ready LogQuery or the message
 * of the first thing wrong with the request (→ 400) — never a silently-wrong result.
 */
export function parseLogQuery(q: Record<string, unknown>): { query: LogQuery } | { error: string } {
  let levels: LogLevel[] | undefined;
  const levelRaw = singleString(q.level);
  if (levelRaw !== undefined) {
    levels = [];
    for (const part of levelRaw.split(",")) {
      const parsed = LogLevelSchema.safeParse(part.trim().toLowerCase());
      if (!parsed.success) return { error: `invalid level: ${part}` };
      levels.push(parsed.data);
    }
  }

  const dates: Record<"from" | "to", Date | undefined> = { from: undefined, to: undefined };
  for (const key of ["from", "to"] as const) {
    const raw = singleString(q[key]);
    if (raw === undefined) continue;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return { error: `invalid ${key}` };
    dates[key] = d;
  }
  if (dates.from && dates.to && dates.from > dates.to)
    return { error: "from must not be after to" };

  let cursor;
  const cursorRaw = singleString(q.cursor);
  if (cursorRaw !== undefined) {
    cursor = decodeLogsCursor(cursorRaw);
    if (!cursor) return { error: "invalid cursor" };
  }

  const requestedLimit = Number(q.limit);
  const limit =
    Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, MAX_LOGS_LIMIT)
      : DEFAULT_LOGS_LIMIT;

  return {
    query: {
      levels,
      service: singleString(q.service),
      environment: singleString(q.environment),
      traceId: singleString(q.traceId),
      search: singleString(q.q),
      from: dates.from,
      to: dates.to,
      limit,
      cursor,
    },
  };
}

/**
 * The one place every route resolves auth (ingest-pipeline.md §8.4): if this returns undefined,
 * a 401 has already been sent and the caller must return immediately without touching any
 * tenant-scoped code — the isolation guarantee depends on that ordering, not on a filter later.
 */
async function requireOrg(
  request: FastifyRequest,
  reply: FastifyReply,
  controlDb: ControlDb,
): Promise<ResolvedOrg | undefined> {
  const apiKey = extractBearerToken(request.headers.authorization);
  if (!apiKey) {
    await reply.code(401).send({ error: "missing bearer token" });
    return undefined;
  }
  const org = await resolveOrgForRequest(apiKey, controlDb);
  if (!org) {
    await reply.code(401).send({ error: "invalid api key" });
    return undefined;
  }
  // 403, not 401: the key is real but its org has been switched off by an operator. 4xx also tells
  // the SDK and the Agent not to retry, so a disabled org's services stop sending instead of
  // hammering the backend.
  if (org.disabled) {
    await reply.code(403).send({ error: "organization is disabled" });
    return undefined;
  }
  noteKeyUse(org, controlDb);
  return org;
}

/**
 * Registers every route/hook onto an already-constructed Fastify instance. Split out from
 * buildServer() so a Vercel deployment entrypoint (app.ts) can construct the Fastify instance
 * itself with a direct `import Fastify from "fastify"` — Vercel's zero-config Fastify detection
 * requires that exact pattern in the recognized entrypoint file, not just a helper that returns
 * an instance internally.
 */
export function registerRoutes(
  app: FastifyInstance,
  controlDb: ControlDb,
  options: { logRetentionDays?: number; adminToken?: string } = {},
): void {
  const tenants = new TenantDbResolver(controlDb.getClient(), {
    logRetentionDays: options.logRetentionDays,
  });
  // The Logs view loads its service/environment dropdowns on every open, so the distinct values are
  // cached per tenant database. Deliberately NOT invalidated on ingest: an active tenant ingests
  // every few seconds, so invalidating there would mean the cache is never hit. Only the TTL
  // expires it — a newly deployed service showing up in the dropdown within a minute is fine.
  const facetsCache = new Map<
    string,
    { at: number; value: { services: string[]; environments: string[] } }
  >();

  // Dev-friendly CORS so a locally-opened static dashboard (packages/dashboard) can call the
  // Query API directly — read-only routes only, and this is a pilot-scale internal tool, not a
  // public API with a real origin allowlist to maintain yet.
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    return payload;
  });

  // A cross-origin fetch carrying an Authorization header (every real request this API takes)
  // is non-simple, so browsers preflight it with OPTIONS first — without a route for it, Fastify
  // 404s the preflight itself and the browser blocks the real request before it's ever sent. The
  // onSend hook above never gets a chance to help: it decorates a response, but there's no
  // matched route to send one from.
  app.options("/*", async (_request, reply) => {
    reply.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    await reply.code(204).send();
  });

  // API docs — public on purpose (no org data in them), so they sit outside requireOrg. The served
  // copy lists "this server" first, so Swagger UI's "Try it out" hits whichever backend you opened.
  const openApiDocument = buildOpenApiDocument();
  const servedOpenApi = {
    ...openApiDocument,
    servers: [{ url: "/", description: "This server" }, ...(openApiDocument.servers as unknown[])],
  };
  app.get("/openapi.json", async (_request, reply) => {
    await reply.send(servedOpenApi);
  });
  app.get("/docs", async (_request, reply) => {
    await reply.type("text/html; charset=utf-8").send(SWAGGER_UI_HTML);
  });

  // ---- Admin ----------------------------------------------------------------------------------

  // Every admin route is authorized by BUGBUSTER_ADMIN_TOKEN, a separate secret from any org's API
  // key. With no admin token configured they answer 404, exactly like routes that don't exist.
  async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const adminToken = options.adminToken;
    if (!adminToken) {
      await reply.code(404).send({ error: "not found" });
      return false;
    }
    const given = extractBearerToken(request.headers.authorization);
    if (!given || !tokensMatch(given, adminToken)) {
      await reply.code(401).send({ error: "invalid admin token" });
      return false;
    }
    return true;
  }

  /** An org as the admin API returns it: settings in effect, status, and its keys (no hashes). */
  function orgView(org: PublicOrg, keys: PublicKey[]) {
    const override =
      org.logRetentionDays !== undefined ? { logRetentionDays: org.logRetentionDays } : {};
    return {
      orgId: org.orgId,
      name: org.name,
      dbName: org.dbName,
      createdAt: org.createdAt,
      disabled: org.disabled === true,
      ...(org.disabledAt ? { disabledAt: org.disabledAt } : {}),
      logRetentionDays: tenants.retentionFor(override),
      retentionOverridden: org.logRetentionDays !== undefined,
      keys: keys.filter((k) => k.orgId === org.orgId),
    };
  }

  // Every org with its status, retention and keys. Key hashes never leave the control database.
  app.get("/admin/orgs", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const [orgs, keys] = await Promise.all([controlDb.listOrgs(), controlDb.listKeys()]);
    await reply.send({ orgs: orgs.map((o) => orgView(o, keys)) });
  });

  // Creates an organization and its first key, and returns that key (once — only the hash is
  // stored).
  app.post<{ Body: unknown }>("/admin/orgs", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;

    const body = (request.body ?? {}) as {
      orgId?: unknown;
      name?: unknown;
      logRetentionDays?: unknown;
      keyName?: unknown;
    };
    if (typeof body.orgId !== "string" || !ORG_ID_PATTERN.test(body.orgId)) {
      await reply.code(400).send({
        error: "orgId must be 1-40 characters: lowercase letters, digits, '-' or '_'",
      });
      return;
    }
    const name = parseName(body.name, MAX_ORG_NAME_CHARS);
    if (name === undefined) {
      await reply.code(400).send({ error: `name must be 1-${MAX_ORG_NAME_CHARS} characters` });
      return;
    }
    const retention = parseRetentionDays(body.logRetentionDays, { allowNull: false });
    if (retention === "invalid") {
      await reply.code(400).send({ error: RETENTION_ERROR });
      return;
    }
    const keyName =
      body.keyName === undefined ? undefined : parseName(body.keyName, MAX_KEY_NAME_CHARS);
    if (body.keyName !== undefined && keyName === undefined) {
      await reply.code(400).send({ error: `keyName must be 1-${MAX_KEY_NAME_CHARS} characters` });
      return;
    }

    const result = await controlDb.createOrgWithGeneratedKey({
      orgId: body.orgId,
      name,
      ...(typeof retention === "number" ? { logRetentionDays: retention } : {}),
      ...(keyName ? { keyName } : {}),
    });
    if (!result.created) {
      await reply.code(409).send({ error: "an org with this id or database already exists" });
      return;
    }
    await controlDb.recordAdminEvent({ action: "org.created", orgId: result.orgId, detail: name });
    const { created: _created, ...org } = result;
    // The key is in this response and nowhere else; nothing in between may keep a copy.
    reply.header("Cache-Control", "no-store");
    await reply.code(201).send(org);
  });

  // Changes an org: its name, its log retention (days, 0 = keep forever, null = the backend
  // default; applied to the org's TTL index at once, for every backend process), and whether it is
  // disabled (its keys are refused with 403; its data is kept).
  app.patch<{ Params: { orgId: string }; Body: unknown }>(
    "/admin/orgs/:orgId",
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      const body = (request.body ?? {}) as {
        name?: unknown;
        logRetentionDays?: unknown;
        disabled?: unknown;
      };
      const change: { name?: string; logRetentionDays?: number | null; disabled?: boolean } = {};
      if (body.name !== undefined) {
        const name = parseName(body.name, MAX_ORG_NAME_CHARS);
        if (name === undefined) {
          await reply.code(400).send({ error: `name must be 1-${MAX_ORG_NAME_CHARS} characters` });
          return;
        }
        change.name = name;
      }
      if (body.logRetentionDays !== undefined) {
        const retention = parseRetentionDays(body.logRetentionDays, { allowNull: true });
        if (retention === "invalid" || retention === undefined) {
          await reply
            .code(400)
            .send({ error: RETENTION_ERROR + ", or null for the backend default" });
          return;
        }
        change.logRetentionDays = retention;
      }
      if (body.disabled !== undefined) {
        if (typeof body.disabled !== "boolean") {
          await reply.code(400).send({ error: "disabled must be true or false" });
          return;
        }
        change.disabled = body.disabled;
      }
      if (Object.keys(change).length === 0) {
        await reply
          .code(400)
          .send({ error: "send at least one of name, logRetentionDays, disabled" });
        return;
      }

      const org = await controlDb.updateOrg(request.params.orgId, change);
      if (!org) {
        await reply.code(404).send({ error: "no such org" });
        return;
      }
      if (change.logRetentionDays !== undefined) {
        const override =
          org.logRetentionDays !== undefined ? { logRetentionDays: org.logRetentionDays } : {};
        await tenants.applyLogRetention(org.dbName, override);
      }
      forgetOrg(org.orgId);
      const orgId = org.orgId;
      if (change.name !== undefined) {
        await controlDb.recordAdminEvent({ action: "org.renamed", orgId, detail: change.name });
      }
      if (change.logRetentionDays !== undefined) {
        await controlDb.recordAdminEvent({
          action: "org.retention_changed",
          orgId,
          detail:
            change.logRetentionDays === null
              ? "backend default"
              : `${change.logRetentionDays} days`,
        });
      }
      if (change.disabled !== undefined) {
        await controlDb.recordAdminEvent({
          action: change.disabled ? "org.disabled" : "org.enabled",
          orgId,
        });
      }
      await reply.send(orgView(org, await controlDb.listKeys(orgId)));
    },
  );

  // A new key for an org, returned once. One key per service or person, so each can be revoked
  // without touching the others.
  app.post<{ Params: { orgId: string }; Body: unknown }>(
    "/admin/orgs/:orgId/keys",
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      const name = parseName(
        (request.body as { name?: unknown } | undefined)?.name,
        MAX_KEY_NAME_CHARS,
      );
      if (name === undefined) {
        await reply.code(400).send({ error: `name must be 1-${MAX_KEY_NAME_CHARS} characters` });
        return;
      }
      const key = await controlDb.createKey(request.params.orgId, name);
      if (!key) {
        await reply.code(404).send({ error: "no such org" });
        return;
      }
      await controlDb.recordAdminEvent({ action: "key.created", orgId: key.orgId, detail: name });
      reply.header("Cache-Control", "no-store");
      await reply.code(201).send(key);
    },
  );

  // Revokes one key: requests with it are refused from now on (on other backend instances within a
  // minute; see AUTH_CACHE_TTL_MS). The org's other keys keep working. Revoking twice is harmless.
  app.delete<{ Params: { orgId: string; keyId: string } }>(
    "/admin/orgs/:orgId/keys/:keyId",
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      const before = (await controlDb.listKeys(request.params.orgId)).find(
        (k) => k.keyId === request.params.keyId,
      );
      const key = await controlDb.revokeKey(request.params.orgId, request.params.keyId);
      if (!key) {
        await reply.code(404).send({ error: "no such key" });
        return;
      }
      forgetOrg(key.orgId);
      if (before && !before.revokedAt) {
        await controlDb.recordAdminEvent({
          action: "key.revoked",
          orgId: key.orgId,
          detail: key.name,
        });
      }
      await reply.send(key);
    },
  );

  // Deletes stored exemplars no issue references (left by backends before the exemplar fix), in
  // one org or all. `dryRun: true` only counts. Events younger than ten minutes are never touched.
  app.post<{ Body: unknown }>("/admin/maintenance/cleanup-events", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const body = (request.body ?? {}) as { dryRun?: unknown; orgId?: unknown };
    const dryRun = body.dryRun === true;
    const orgs = (await controlDb.listOrgs()).filter(
      (o) => body.orgId === undefined || o.orgId === body.orgId,
    );
    if (body.orgId !== undefined && orgs.length === 0) {
      await reply.code(404).send({ error: "no such org" });
      return;
    }
    const client = controlDb.getClient();
    const results = [];
    for (const org of orgs) {
      const db = client.db(org.dbName);
      const events = dryRun
        ? await countUnreferencedEvents(db)
        : await deleteUnreferencedEvents(db);
      results.push({ orgId: org.orgId, events });
    }
    const total = results.reduce((sum, r) => sum + r.events, 0);
    if (!dryRun && total > 0) {
      await controlDb.recordAdminEvent({
        action: "events.cleaned_up",
        detail: `${total} unreferenced events deleted`,
      });
    }
    await reply.send({ dryRun, total, orgs: results });
  });

  // The admin change history, newest first: what changed, in which org, and when.
  app.get<{ Querystring: { limit?: string } }>("/admin/events", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 200);
    await reply.send({ events: await controlDb.listAdminEvents(limit) });
  });

  // The admin page. It holds no data (everything it shows comes from the routes above, with the
  // token the operator types in), but it is only served where admin routes are enabled. A strict
  // content policy: its own inline script and style, fonts from Google, requests to this backend
  // only, and never inside a frame.
  app.get("/admin", async (_request, reply) => {
    if (!options.adminToken) {
      await reply.code(404).send({ error: "not found" });
      return;
    }
    reply.header(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline'; " +
        "style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
        "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; " +
        "frame-ancestors 'none'",
    );
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cache-Control", "no-store");
    await reply.type("text/html; charset=utf-8").send(ADMIN_PAGE_HTML);
  });

  // What each org's data costs in MongoDB: per-collection size on disk and in indexes, the
  // compressor in use, log lines per day, and exemplars waiting for cleanup. `?orgId=` for one org.
  app.get<{ Querystring: { orgId?: string } }>("/admin/storage", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const wanted = request.query.orgId;
    const orgs = (await controlDb.listOrgs()).filter((o) => !wanted || o.orgId === wanted);
    if (wanted && orgs.length === 0) {
      await reply.code(404).send({ error: "no such org" });
      return;
    }
    const client = controlDb.getClient();
    const reports = [];
    for (const org of orgs) {
      reports.push(await orgStorageReport(client.db(org.dbName), org, tenants.retentionFor({})));
    }
    reports.sort((a, b) => b.totalBytes - a.totalBytes);
    await reply.send({
      generatedAt: new Date().toISOString(),
      defaultLogRetentionDays: tenants.retentionFor({}),
      totalBytes: reports.reduce((sum, r) => sum + r.totalBytes, 0),
      orgs: reports,
    });
  });

  // NDJSON bodies pass through without any JSON parsing here — see ingest/edge.ts's v1 nuance on
  // "never parse the body": that guarantee is about not interpreting the envelope's CONTENTS, not
  // about the transport encoding. Decompression happens here because it's a wire-format detail
  // between the Agent and the backend (ingest-pipeline.md §6.4), not a body-parsing concern — the
  // Agent's HttpClient always zstd-compresses (its job, not the SDK's); a direct-mode SDK talking
  // straight to this endpoint (the browser/serverless fallback) sends uncompressed bytes, so this
  // only acts when the header says compression was actually used.
  // JSON bodies, with one difference from Fastify's default: an empty body is "no body", not a
  // 400. Clients routinely send Content-Type: application/json on every request, DELETE included,
  // and refusing those with FST_ERR_CTP_EMPTY_JSON_BODY is a confusing failure for no benefit.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = (body as string).trim();
    if (text === "") {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch {
      const err = new Error("request body is not valid JSON") as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  app.addContentTypeParser("application/x-ndjson", { parseAs: "buffer" }, (req, body, done) => {
    const buf = body as Buffer;
    if (req.headers["content-encoding"] === "zstd") {
      try {
        done(null, zstdDecompressSync(buf));
        return;
      } catch (err) {
        done(err as Error);
        return;
      }
    }
    done(null, buf);
  });

  app.post("/ingest", async (request, reply) => {
    const org = await requireOrg(request, reply, controlDb);
    if (!org) return;

    const db = await tenants.forOrgDb(org.dbName, org);
    await processEnvelope(db, (request.body as Buffer | undefined) ?? Buffer.alloc(0));

    const directives = computeDirectives(CONFIG_VERSION);
    reply.header(HEADER_SAMPLE_DIRECTIVE, JSON.stringify(directives.sample));
    reply.header(HEADER_SUPPRESS_FINGERPRINTS, JSON.stringify(directives.suppressFingerprints));
    reply.header(HEADER_CONFIG_VERSION, String(directives.configVersion));
    if (directives.retryAfterSeconds !== undefined) {
      reply.header(HEADER_RETRY_AFTER, String(directives.retryAfterSeconds));
    }
    await reply.code(202).send();
  });

  app.get<{ Querystring: { limit?: string; cursor?: string } }>(
    "/issues",
    async (request, reply) => {
      const org = await requireOrg(request, reply, controlDb);
      if (!org) return;

      const requestedLimit = Number(request.query.limit);
      const limit =
        Number.isInteger(requestedLimit) && requestedLimit > 0
          ? Math.min(requestedLimit, MAX_ISSUES_LIMIT)
          : DEFAULT_ISSUES_LIMIT;

      let cursor;
      if (request.query.cursor) {
        cursor = decodeIssuesCursor(request.query.cursor);
        if (!cursor) {
          await reply.code(400).send({ error: "invalid cursor" });
          return;
        }
      }

      const db = await tenants.forOrgDb(org.dbName, org);
      const page = await listIssues(db, { limit, cursor });
      await reply.send({ issues: page.issues.map(attachFidelity), nextCursor: page.nextCursor });
    },
  );

  app.get<{ Params: { fingerprint: string } }>("/issues/:fingerprint", async (request, reply) => {
    const org = await requireOrg(request, reply, controlDb);
    if (!org) return;

    const db = await tenants.forOrgDb(org.dbName, org);
    const issue = await getIssue(db, request.params.fingerprint);
    if (!issue) {
      await reply.code(404).send({ error: "not found" });
      return;
    }
    await reply.send(attachFidelity(issue));
  });

  // Resolves the exemplarRefs -> full BugBusterEvent bodies gap (docs/api.md's "Not yet built"):
  // the aggregate route intentionally never inlines full event payloads (they can be large, and
  // most issue views never need them), so viewing one is a deliberate second request.
  app.get<{ Params: { fingerprint: string } }>(
    "/issues/:fingerprint/exemplars",
    async (request, reply) => {
      const org = await requireOrg(request, reply, controlDb);
      if (!org) return;

      const db = await tenants.forOrgDb(org.dbName, org);
      const issue = await getIssue(db, request.params.fingerprint);
      if (!issue) {
        await reply.code(404).send({ error: "not found" });
        return;
      }

      const events = await getExemplarsByIds(
        db,
        issue.exemplarRefs.map((ref) => ref.eventId),
      );
      const eventById = new Map(events.map((event) => [event.eventId, event]));
      // Ordered per the issue's own exemplarRefs (its documented selection-policy order), not
      // Mongo's $in return order, which is unspecified.
      const exemplars = issue.exemplarRefs
        .map((ref) => eventById.get(ref.eventId))
        .filter((event) => event !== undefined);
      await reply.send({ exemplars });
    },
  );

  // ---- Logs (the "normal logs" half of the product; see packages/types/src/log.ts) -----------

  // Newest first. Filters: level (comma list), service, environment, traceId, q (substring),
  // from/to (ISO), limit, cursor. Same auth-before-tenant ordering as every other route.
  app.get<{ Querystring: Record<string, unknown> }>("/logs", async (request, reply) => {
    const org = await requireOrg(request, reply, controlDb);
    if (!org) return;

    const parsed = parseLogQuery(request.query);
    if ("error" in parsed) {
      await reply.code(400).send({ error: parsed.error });
      return;
    }

    const db = await tenants.forOrgDb(org.dbName, org);
    const page = await queryLogs(db, parsed.query);
    await reply.send({ logs: page.logs, nextCursor: page.nextCursor });
  });

  // Distinct services/environments for the dashboard's filter dropdowns.
  app.get("/logs/facets", async (request, reply) => {
    const org = await requireOrg(request, reply, controlDb);
    if (!org) return;

    const cached = facetsCache.get(org.dbName);
    if (cached && Date.now() - cached.at < FACETS_CACHE_MS) {
      await reply.send(cached.value);
      return;
    }
    const db = await tenants.forOrgDb(org.dbName, org);
    const value = await getLogFacets(db);
    facetsCache.set(org.dbName, { at: Date.now(), value });
    await reply.send(value);
  });
}

export function buildServer(config: BackendConfig, controlDb: ControlDb): FastifyInstance {
  const app = Fastify({ bodyLimit: config.ingestMaxBodyBytes });
  registerRoutes(app, controlDb, {
    logRetentionDays: config.logRetentionDays,
    adminToken: config.adminToken,
  });
  return app;
}
