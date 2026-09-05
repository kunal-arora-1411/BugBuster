import { BackendConfigSchema } from "@bugbuster/types";
import { ControlDb } from "./db/control.js";
import { buildServer } from "./server.js";

export { ControlDb, hashApiKey } from "./db/control.js";
export { TenantDbResolver } from "./db/tenant.js";
export { buildServer } from "./server.js";
export * from "./db/collections/issues.js";
export * from "./db/collections/events.js";
export * from "./db/collections/deploys.js";

export async function startBackend(rawConfig: unknown): Promise<{ close: () => Promise<void> }> {
  const config = BackendConfigSchema.parse(rawConfig);

  const controlDb = new ControlDb(config.controlDbUri);
  await controlDb.connect();

  const app = buildServer(config, controlDb);
  await app.listen({ port: config.port, host: "0.0.0.0" });

  return {
    async close() {
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
  }).catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
