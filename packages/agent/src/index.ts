import { AgentConfigSchema } from "@bugbuster/types";
import { CircuitBreaker } from "./circuit-breaker.js";
import { AgentHttpClient } from "./http-client.js";
import { DiskSpool } from "./spool.js";
import { UdsServer } from "./uds-server.js";

export { CircuitBreaker } from "./circuit-breaker.js";
export { AgentHttpClient, AgentHttpClientError } from "./http-client.js";
export { DiskSpool } from "./spool.js";
export { UdsServer } from "./uds-server.js";
export { mergeFoldDeltas } from "./merge-fold-deltas.js";
export { buildOutgoingEnvelope, mergeDropCounters } from "./build-outgoing-envelope.js";

export async function startAgent(rawConfig: unknown): Promise<UdsServer> {
  const config = AgentConfigSchema.parse(rawConfig);

  const breaker = new CircuitBreaker({
    failureThreshold: config.circuitBreakerFailureThreshold,
    cooldownMs: config.circuitBreakerCooldownMs,
  });

  const httpClient = new AgentHttpClient({
    url: config.backendUrl,
    apiKey: config.apiKey,
    totalTimeoutMs: config.totalTimeoutMs,
    maxRetries: config.maxRetries,
    circuitBreaker: breaker,
  });

  const spool = config.diskSpoolPath
    ? new DiskSpool({
        dir: config.diskSpoolPath,
        maxBytes: config.diskSpoolMaxBytes ?? 64 * 1024 * 1024,
        ttlMs: 24 * 60 * 60 * 1000,
      })
    : undefined;

  const server = new UdsServer({ socketPath: config.socketPath, httpClient, spool });
  await server.start();
  return server;
}

// Only run when this file is the actual process entry point (the `bugbuster-agent` bin), not
// when imported by tests or by another package composing the Agent's pieces directly.
if (process.argv[1]?.endsWith("index.js")) {
  startAgent({
    socketPath: process.env.BUGBUSTER_AGENT_SOCKET,
    backendUrl: process.env.BUGBUSTER_BACKEND_URL ?? "http://localhost:8080/ingest",
    apiKey: process.env.BUGBUSTER_API_KEY ?? "",
    diskSpoolPath: process.env.BUGBUSTER_AGENT_SPOOL_DIR,
  })
    .then((server) => {
      console.log(
        `bugbuster-agent listening on ${process.env.BUGBUSTER_AGENT_SOCKET ?? "(default socket path)"}`,
      );
      process.on("SIGTERM", () => void server.stop().then(() => process.exit(0)));
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
