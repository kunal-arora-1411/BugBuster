import { BackendConfigSchema } from "@bugbusterhq/types";
import { ControlDb } from "./db/control.js";
import {
  parseAdminToken,
  parseAlertsConfig,
  parseCronSecret,
  parseLogRetentionDays,
} from "./env.js";
import { createServer } from "./build-server.js";

export { ControlDb, hashApiKey } from "./db/control.js";
export { TenantDbResolver } from "./db/tenant.js";
export { buildServer } from "./build-server.js";
export * from "./db/collections/issues.js";
export * from "./db/collections/events.js";
export * from "./db/collections/deploys.js";
export * from "./db/collections/logs.js";

const ALERT_SWEEP_MS = 60_000;

export async function startBackend(rawConfig: unknown): Promise<{ close: () => Promise<void> }> {
  const config = BackendConfigSchema.parse(rawConfig);

  const controlDb = new ControlDb(config.controlDbUri);
  await controlDb.connect();

  const { app, notifier } = createServer(config, controlDb);
  await app.listen({ port: config.port, host: "0.0.0.0" });

  // A long-running backend sends alerts that had to wait (the hourly cap, a failed send) on its
  // own; on Vercel a scheduler calling /internal/alerts/run does this instead.
  const alertTimer = notifier
    ? setInterval(() => void notifier.runAll().catch(() => {}), ALERT_SWEEP_MS)
    : undefined;
  alertTimer?.unref();

  return {
    async close() {
      if (alertTimer) clearInterval(alertTimer);
      await app.close();
      await controlDb.close();
    },
  };
}

// Only run the server when this file is the actual process entry point, not when imported by tests.
if (process.argv[1]?.endsWith("index.js")) {
  startBackend({
    controlDbUri: process.env.BUGBUSTER_CONTROL_DB_URI ?? "mongodb://localhost:27017",
    port: Number(process.env.PORT ?? 8080),
    logRetentionDays: parseLogRetentionDays(process.env.BUGBUSTER_LOG_RETENTION_DAYS),
    adminToken: parseAdminToken(process.env.BUGBUSTER_ADMIN_TOKEN),
    alerts: parseAlertsConfig(process.env),
    cronSecret: parseCronSecret(process.env),
  }).catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
