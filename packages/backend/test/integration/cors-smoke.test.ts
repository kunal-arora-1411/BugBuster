import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ControlDb } from "../../src/db/control.js";
import { buildServer } from "../../src/server.js";

let mongo: MongoMemoryServer;
let controlDb: ControlDb;
let app: FastifyInstance;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  controlDb = new ControlDb(mongo.getUri());
  await controlDb.connect();
  await controlDb.createOrg({ orgId: "org_x", name: "X", dbName: "bugbuster_org_x", apiKey: "k" });
  app = buildServer({ port: 0, controlDbUri: mongo.getUri(), ingestMaxBodyBytes: 4096 }, controlDb);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await controlDb.close();
  await mongo.stop();
});

describe("CORS for the dashboard", () => {
  it("GET /issues includes Access-Control-Allow-Origin so a locally-opened HTML file can call it", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/issues",
      headers: { authorization: "Bearer k" },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.issues)).toBe(true);
  });
});
