import express from "express";
import { init } from "@bugbuster/sdk-node";

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

const app = express();

app.get("/", (_req, res) => {
  res.send("BugBuster demo-app is running. Try GET /throw or GET /throw-slow.");
});

app.get("/throw", (_req, res) => {
  try {
    throw new Error("simulated PaymentTimeout for manual testing");
  } catch (err) {
    bugbuster.captureException(err);
    res.status(500).send("captured and reported");
  }
});

app.get("/throw-slow", (_req, res) => {
  const start = Date.now();
  setTimeout(() => {
    try {
      throw new Error("simulated slow request timeout");
    } catch (err) {
      bugbuster.captureException(err, { release: "1.0.0" });
      res.status(500).send(`captured after ${Date.now() - start}ms`);
    }
  }, 50);
});

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => {
  console.log(`demo-app listening on http://localhost:${port}`);
});

process.on("SIGTERM", () => {
  server.close(() => {
    void bugbuster.shutdown().then(() => process.exit(0));
  });
});
