import { zstdDecompressSync } from "node:zlib";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { BackendConfig, ResolvedOrg } from "@bugbusterhq/types";
import {
  HEADER_CONFIG_VERSION,
  HEADER_RETRY_AFTER,
  HEADER_SAMPLE_DIRECTIVE,
  HEADER_SUPPRESS_FINGERPRINTS,
} from "@bugbusterhq/types";
import type { ControlDb } from "./db/control.js";
import { TenantDbResolver } from "./db/tenant.js";
import { extractBearerToken, resolveOrgForRequest } from "./ingest/edge.js";
import { processEnvelope } from "./ingest/processor.js";
import { decodeIssuesCursor, getIssue, listIssues } from "./db/collections/issues.js";
import { getExemplarsByIds } from "./db/collections/events.js";
import { attachFidelity } from "./query/fidelity.js";
import { computeDirectives } from "./directives.js";

const CONFIG_VERSION = 1;
const DEFAULT_ISSUES_LIMIT = 50;
const MAX_ISSUES_LIMIT = 200;

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
  return org;
}

/**
 * Registers every route/hook onto an already-constructed Fastify instance. Split out from
 * buildServer() so a Vercel deployment entrypoint (app.ts) can construct the Fastify instance
 * itself with a direct `import Fastify from "fastify"` — Vercel's zero-config Fastify detection
 * requires that exact pattern in the recognized entrypoint file, not just a helper that returns
 * an instance internally.
 */
export function registerRoutes(app: FastifyInstance, controlDb: ControlDb): void {
  const tenants = new TenantDbResolver(controlDb.getClient());

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
    reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    await reply.code(204).send();
  });

  // NDJSON bodies pass through without any JSON parsing here — see ingest/edge.ts's v1 nuance on
  // "never parse the body": that guarantee is about not interpreting the envelope's CONTENTS, not
  // about the transport encoding. Decompression happens here because it's a wire-format detail
  // between the Agent and the backend (ingest-pipeline.md §6.4), not a body-parsing concern — the
  // Agent's HttpClient always zstd-compresses (its job, not the SDK's); a direct-mode SDK talking
  // straight to this endpoint (the browser/serverless fallback) sends uncompressed bytes, so this
  // only acts when the header says compression was actually used.
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

    const db = await tenants.forOrgDb(org.dbName);
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

      const db = await tenants.forOrgDb(org.dbName);
      const page = await listIssues(db, { limit, cursor });
      await reply.send({ issues: page.issues.map(attachFidelity), nextCursor: page.nextCursor });
    },
  );

  app.get<{ Params: { fingerprint: string } }>("/issues/:fingerprint", async (request, reply) => {
    const org = await requireOrg(request, reply, controlDb);
    if (!org) return;

    const db = await tenants.forOrgDb(org.dbName);
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

      const db = await tenants.forOrgDb(org.dbName);
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
}

export function buildServer(config: BackendConfig, controlDb: ControlDb): FastifyInstance {
  const app = Fastify({ bodyLimit: config.ingestMaxBodyBytes });
  registerRoutes(app, controlDb);
  return app;
}
