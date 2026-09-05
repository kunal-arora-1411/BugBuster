import { zstdDecompressSync } from "node:zlib";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { BackendConfig, ResolvedOrg } from "@bugbuster/types";
import {
  HEADER_CONFIG_VERSION,
  HEADER_RETRY_AFTER,
  HEADER_SAMPLE_DIRECTIVE,
  HEADER_SUPPRESS_FINGERPRINTS,
} from "@bugbuster/types";
import type { ControlDb } from "./db/control.js";
import { TenantDbResolver } from "./db/tenant.js";
import { extractBearerToken, resolveOrgForRequest } from "./ingest/edge.js";
import { processEnvelope } from "./ingest/processor.js";
import { getIssue, listIssues } from "./db/collections/issues.js";
import { attachFidelity } from "./query/fidelity.js";
import { computeDirectives } from "./directives.js";

const CONFIG_VERSION = 1;

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

export function buildServer(config: BackendConfig, controlDb: ControlDb): FastifyInstance {
  const app = Fastify({ bodyLimit: config.ingestMaxBodyBytes });
  const tenants = new TenantDbResolver(controlDb.getClient());

  // Dev-friendly CORS so a locally-opened static dashboard (packages/dashboard) can call the
  // Query API directly — read-only routes only, and this is a pilot-scale internal tool, not a
  // public API with a real origin allowlist to maintain yet.
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    return payload;
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

  app.get("/issues", async (request, reply) => {
    const org = await requireOrg(request, reply, controlDb);
    if (!org) return;

    const db = await tenants.forOrgDb(org.dbName);
    const issues = await listIssues(db);
    await reply.send({ issues: issues.map(attachFidelity) });
  });

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

  return app;
}
