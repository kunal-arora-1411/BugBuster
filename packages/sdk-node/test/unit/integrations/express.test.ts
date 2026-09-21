import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createExpressIntegration } from "../../../src/integrations/express.js";
import type { CaptureEngine } from "../../../src/capture.js";

function mockClient() {
  const exceptions: unknown[] = [];
  const messages: unknown[] = [];
  const client: CaptureEngine = {
    captureException: (error) => void exceptions.push(error),
    captureMessage: (message) => void messages.push(message),
  };
  return { client, exceptions, messages };
}

function fakeResponse(statusCode: number) {
  const res = new EventEmitter() as EventEmitter & { statusCode: number };
  res.statusCode = statusCode;
  return res;
}

describe("createExpressIntegration — requestHandler", () => {
  it("synthesizes a HandledHttpError for a 5xx response nothing else captured", () => {
    const { client, exceptions } = mockClient();
    const bb = createExpressIntegration(client);
    const req = { method: "GET", route: { path: "/widgets" } };
    const res = fakeResponse(500);

    bb.requestHandler(req, res as never, () => {});
    res.emit("finish");

    expect(exceptions).toHaveLength(1);
    const err = exceptions[0] as Error;
    expect(err.message).toBe("HTTP 500: GET /widgets");
    expect(err.name).toBe("HandledHttpError:GET:/widgets");
  });

  it("does not synthesize a duplicate error when the handler already captured one", () => {
    const { client, exceptions } = mockClient();
    const bb = createExpressIntegration(client);
    const req = { method: "POST", route: { path: "/charge" } };
    const res = fakeResponse(500);

    bb.requestHandler(req, res as never, () => {
      bb.captureException(new Error("card declined"));
    });
    res.emit("finish");

    expect(exceptions).toHaveLength(1);
    expect((exceptions[0] as Error).message).toBe("card declined");
  });

  it("does nothing for a successful response", () => {
    const { client, exceptions } = mockClient();
    const bb = createExpressIntegration(client);
    const req = { method: "GET", route: { path: "/ok" } };
    const res = fakeResponse(200);

    bb.requestHandler(req, res as never, () => {});
    res.emit("finish");

    expect(exceptions).toHaveLength(0);
  });

  it("falls back to <unmatched> when Express hasn't matched a route", () => {
    const { client, exceptions } = mockClient();
    const bb = createExpressIntegration(client);
    const req = { method: "GET" };
    const res = fakeResponse(503);

    bb.requestHandler(req, res as never, () => {});
    res.emit("finish");

    expect((exceptions[0] as Error).message).toBe("HTTP 503: GET <unmatched>");
  });

  it("isolates captured-state across concurrent requests (no cross-request leakage)", () => {
    const { client, exceptions } = mockClient();
    const bb = createExpressIntegration(client);

    const reqA = { method: "GET", route: { path: "/a" } };
    const resA = fakeResponse(500);
    const reqB = { method: "GET", route: { path: "/b" } };
    const resB = fakeResponse(500);

    // Request A captures its own error; request B captures nothing.
    bb.requestHandler(reqA, resA as never, () => bb.captureException(new Error("a failed")));
    bb.requestHandler(reqB, resB as never, () => {});
    resA.emit("finish");
    resB.emit("finish");

    expect(exceptions).toHaveLength(2);
    expect((exceptions[0] as Error).message).toBe("a failed");
    expect((exceptions[1] as Error).message).toBe("HTTP 500: GET /b");
  });
});

describe("createExpressIntegration — instrumentConsole", () => {
  it("captures an Error passed to console.error, ignores a bare string", () => {
    const { client, exceptions } = mockClient();
    const bb = createExpressIntegration(client);
    const restore = bb.instrumentConsole();
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      console.error("[Label] failed:", new Error("boom"));
      console.error("just a string, no error object");
    } finally {
      restore();
      spy.mockRestore();
    }
    expect(exceptions).toHaveLength(1);
    expect((exceptions[0] as Error).message).toBe("boom");
  });

  it("captures a bare string passed to console.warn as a message, and an Error as an exception", () => {
    const { client, exceptions, messages } = mockClient();
    const bb = createExpressIntegration(client);
    const restore = bb.instrumentConsole();
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      console.warn("cache warmup skipped");
      console.warn(new Error("warn-level failure"));
    } finally {
      restore();
      spy.mockRestore();
    }
    expect(messages).toEqual(["cache warmup skipped"]);
    expect(exceptions).toHaveLength(1);
    expect((exceptions[0] as Error).message).toBe("warn-level failure");
  });

  it("restore() returns console.error/console.warn to their originals", () => {
    const { client } = mockClient();
    const bb = createExpressIntegration(client);
    const originalError = console.error;
    const originalWarn = console.warn;
    const restore = bb.instrumentConsole();
    expect(console.error).not.toBe(originalError);
    restore();
    expect(console.error).toBe(originalError);
    expect(console.warn).toBe(originalWarn);
  });
});
