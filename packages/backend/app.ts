// Vercel deployment entrypoint — deliberately separate from src/index.ts.
//
// Vercel's zero-config Fastify support requires a recognized entrypoint name
// (app|index|server, at the project root or under src/) that directly
// `import`s fastify, constructs the instance, and calls .listen() in that
// same file. src/index.ts's own entry logic is guarded behind an argv check
// (so importing it in tests never starts a real server), and src/build-server.ts
// builds the instance internally rather than importing fastify at this top
// level — so this file exists purely to satisfy that detection, reusing the
// same route registration as every other entry point via registerRoutes().
import Fastify from "fastify";
import { BackendConfigSchema } from "@bugbusterhq/types";
import { ControlDb } from "./src/db/control.js";
import { registerRoutes } from "./src/build-server.js";

const config = BackendConfigSchema.parse({
  controlDbUri: process.env.BUGBUSTER_CONTROL_DB_URI ?? process.env.MONGODB_URI,
  port: Number(process.env.PORT ?? 8080),
});

const controlDb = new ControlDb(config.controlDbUri);
await controlDb.connect();

const fastify = Fastify({ bodyLimit: config.ingestMaxBodyBytes });
registerRoutes(fastify, controlDb);
fastify.listen({ port: config.port, host: "0.0.0.0" });
