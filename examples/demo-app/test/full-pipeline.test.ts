import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ControlDb, buildServer } from "@bugbuster/backend";
import { AgentHttpClient, UdsServer } from "@bugbuster/agent";
import { init, type BugBusterClient } from "@bugbuster/sdk-node";

/**
 * The genuine end-to-end proof (implementation plan M5's done criteria): a real SDK captures a
 * real exception, sends it over a real Unix domain socket to a real Agent process-equivalent,
 * which forwards it over a real HTTP connection to a real backend backed by a real MongoDB — and
 * the result is retrievable via the real Query API with the correct fingerprint and count.
 *
 * Every component here is the actual class used in production, not a stub — only the "separate
 * OS process" boundary is collapsed (Agent and backend run in this same test process), which
 * doesn't change any of the wire protocols being exercised.
 */

function freshSocketPath(): string {
  const id = `bugbuster-e2e-${process.pid}-${Math.random().toString(36).slice(2)}`;
  return platform === "win32" ? `\\\\.\\pipe\\${id}` : join(tmpdir(), `${id}.sock`);
}

let mongo: MongoMemoryServer;
let controlDb: ControlDb;
let backend: FastifyInstance;
let backendPort: number;
let agent: UdsServer;
let sdk: BugBusterClient;

const ORG = { orgId: "org_demo", name: "Demo", dbName: "bugbuster_org_demo", apiKey: "demo-key" };

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();

  controlDb = new ControlDb(mongo.getUri());
  await controlDb.connect();
  await controlDb.createOrg(ORG);

  backend = buildServer(
    { port: 0, controlDbUri: mongo.getUri(), ingestMaxBodyBytes: 1024 * 1024 },
    controlDb,
  );
  await backend.listen({ port: 0, host: "127.0.0.1" });
  backendPort = (backend.server.address() as { port: number }).port;

  const socketPath = freshSocketPath();
  const httpClient = new AgentHttpClient({
    url: `http://127.0.0.1:${backendPort}/ingest`,
    apiKey: ORG.apiKey,
  });
  agent = new UdsServer({ socketPath, httpClient, flushIntervalMs: 60_000 }); // manual flush() below
  await agent.start();

  sdk = init({
    project: "demo-app",
    apiKey: ORG.apiKey,
    agentSocketPath: socketPath,
    flushMaxDelayMs: 60_000, // manual shutdown()-triggered flush below
  });
}, 120_000); // first run downloads mongodb-memory-server's own mongod binary into this package's cache

afterAll(async () => {
  await agent.stop();
  await backend.close();
  await controlDb.close();
  await mongo.stop();
});

// A shared throw site, invoked from the SAME calling frame every time. This matters: the
// fingerprint deliberately hashes multiple stack frames, not just the throw site itself
// (packages/sdk-node/src/worker/fingerprint.ts — "two different lines in the same function are,
// structurally, different bugs until proven otherwise"), so a caller one frame up genuinely
// changes the fingerprint too. That's correct, real-world behavior (the same shared utility
// throwing from two unrelated call sites IS arguably two different occurrences worth
// distinguishing) — it just means this test must call the throw site from one fixed place to
// correctly exercise folding, rather than from two separate `it()` blocks (which would legitimately
// produce two different fingerprints, proving nothing about folding).
function triggerAndCapture(sdkClient: BugBusterClient): void {
  try {
    throw new Error("simulated PaymentTimeout for the E2E test");
  } catch (err) {
    sdkClient.captureException(err);
  }
}

describe("full pipeline: SDK -> Agent (UDS) -> backend (HTTP) -> MongoDB -> Query API", () => {
  it("throwing the same error twice from the same call site folds into one issue with count 2", async () => {
    // Both occurrences call `triggerAndCapture(sdk)` from this SAME loop body line — not two
    // separately-written call expressions, which (per the comment above) would legitimately
    // fingerprint as two different occurrences and prove nothing about folding.
    for (let i = 0; i < 2; i++) {
      triggerAndCapture(sdk);
      await sdk.shutdown(); // SDK -> Agent, over a real UDS/named-pipe connection
      await agent.flush(); // Agent -> backend, over a real HTTP connection
    }

    const res = await backend.inject({
      method: "GET",
      url: "/issues",
      headers: { authorization: `Bearer ${ORG.apiKey}` },
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as { issues: { fingerprint: string; count: number }[] };
    expect(body.issues).toHaveLength(1); // one issue, not two — the fold worked
    expect(body.issues[0]?.count).toBe(2); // both occurrences counted, folded not duplicated
  });
});
