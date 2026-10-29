import { init } from "@bugbusterhq/sdk-node";
import { buildApp } from "./app.js";

/**
 * A minimal instrumented service — the manual-testing target for the whole pipeline. See
 * docs/runbook.md for how to run this against a real Agent + backend + MongoDB.
 */
const bugbuster = init({
  project: process.env.BUGBUSTER_PROJECT ?? "demo-app",
  apiKey: process.env.BUGBUSTER_API_KEY ?? "dev-key",
  backendUrl: process.env.BUGBUSTER_BACKEND_URL ?? "http://localhost:8080/ingest",
  agentSocketPath: process.env.BUGBUSTER_AGENT_SOCKET ?? "/var/run/bugbuster/agent.sock",
  environment: "development",
});

const { app, bb } = buildApp(bugbuster);

// Opt in to shipping console.log/info/debug/warn/error output as log lines (console.error and
// console.warn are always hooked for exception capture; `logs: true` adds the rest).
bb.instrumentConsole({ logs: true });

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => {
  console.log(`demo-app listening on http://localhost:${port}`);
});

process.on("SIGTERM", () => {
  server.close(() => {
    void bugbuster.shutdown().then(() => process.exit(0));
  });
});
