import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerRoutes } from "../../src/build-server.js";
import type { ControlDb } from "../../src/db/control.js";
import { buildOpenApiDocument } from "../../src/openapi.js";

// None of the routes below are called with a real key, so no database is ever reached.
const noDb = { getClient: () => ({}) } as unknown as ControlDb;

/** Every method + path the backend actually registers, in OpenAPI's `{param}` path syntax. */
function registeredRoutes(): string[] {
  const app = Fastify();
  const routes: string[] = [];
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      // HEAD is Fastify's automatic twin of every GET; OPTIONS /* is the CORS preflight catch-all.
      if (method === "HEAD" || method === "OPTIONS") continue;
      routes.push(`${method.toLowerCase()} ${route.url.replace(/:(\w+)/g, "{$1}")}`);
    }
  });
  registerRoutes(app, noDb);
  return routes.sort();
}

function documentedRoutes(doc: Record<string, unknown>): string[] {
  const paths = doc.paths as Record<string, Record<string, unknown>>;
  return Object.entries(paths)
    .flatMap(([path, ops]) => Object.keys(ops).map((method) => `${method} ${path}`))
    .sort();
}

describe("OpenAPI document", () => {
  it("documents exactly the routes the backend registers — no more, no fewer", () => {
    expect(documentedRoutes(buildOpenApiDocument())).toEqual(registeredRoutes());
  });

  it("the committed docs/openapi.json is up to date (run `pnpm --filter @bugbusterhq/backend openapi`)", () => {
    const committed = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../../../docs/openapi.json", import.meta.url)),
        "utf8",
      ),
    );
    expect(committed).toEqual(buildOpenApiDocument());
  });

  it("generates the data schemas from the wire types (spot check)", () => {
    interface ObjectSchema {
      required: string[];
      properties: Record<string, { enum?: string[] }>;
    }
    const schemas = (buildOpenApiDocument().components as { schemas: Record<string, ObjectSchema> })
      .schemas;
    expect(schemas.LogEntry?.required).toEqual(
      expect.arrayContaining(["logId", "timestamp", "level", "message", "service"]),
    );
    expect(schemas.LogEntry?.properties.level?.enum).toEqual(["debug", "info", "warn", "error"]);
    expect(schemas.Event?.properties.exemplarRole?.enum).toContain("slowest");
  });

  it("serves /openapi.json and /docs without an API key, listing this server first", async () => {
    const app = Fastify();
    registerRoutes(app, noDb);

    const spec = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(spec.statusCode).toBe(200);
    expect(spec.json().openapi).toBe("3.1.0");
    expect(spec.json().servers[0]).toEqual({ url: "/", description: "This server" });

    const docs = await app.inject({ method: "GET", url: "/docs" });
    expect(docs.statusCode).toBe(200);
    expect(docs.headers["content-type"]).toMatch(/^text\/html/);
    expect(docs.body).toContain("./openapi.json");
  });
});
