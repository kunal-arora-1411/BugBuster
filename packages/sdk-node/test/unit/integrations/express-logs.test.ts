import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { LogLevel } from "@bugbusterhq/types";
import { createExpressIntegration } from "../../../src/integrations/express.js";
import { getCurrentContext } from "../../../src/context.js";

interface Logged {
  level: LogLevel;
  message: string;
  fields?: Record<string, unknown>;
  traceId?: string;
}

function mockClient() {
  const logs: Logged[] = [];
  const exceptions: unknown[] = [];
  const client = {
    captureException: (e: unknown) => void exceptions.push(e),
    captureMessage: () => {},
    captureLog: (level: LogLevel, message: string, fields?: Record<string, unknown>) =>
      void logs.push({ level, message, fields, traceId: getCurrentContext()?.traceId }),
  };
  return { client, logs, exceptions };
}

function fakeResponse(statusCode: number) {
  const res = new EventEmitter() as EventEmitter & { statusCode: number };
  res.statusCode = statusCode;
  return res;
}

describe("express request logging (logRequests)", () => {
  it("is off by default: a finished request writes no log line", () => {
    const { client, logs } = mockClient();
    const bb = createExpressIntegration(client);
    const res = fakeResponse(200);
    bb.requestHandler({ method: "GET", url: "/a" } as never, res as never, () => {});
    res.emit("finish");
    expect(logs).toHaveLength(0);
  });

  it("logs method, path, status, duration, and matched route when enabled", () => {
    const { client, logs } = mockClient();
    const bb = createExpressIntegration(client, { logRequests: true });
    const req = {
      method: "GET",
      originalUrl: "/orders/42",
      route: { path: "/orders/:id" },
      requestId: "req-7",
    };
    const res = fakeResponse(200);
    bb.requestHandler(req as never, res as never, () => {});
    res.emit("finish");

    expect(logs).toHaveLength(1);
    const [line] = logs;
    expect(line?.level).toBe("info");
    expect(line?.message).toMatch(/^GET \/orders\/42 200 [\d.]+ms$/);
    expect(line?.fields).toMatchObject({
      method: "GET",
      path: "/orders/42",
      route: "/orders/:id",
      status: 200,
      requestId: "req-7",
    });
    expect(typeof line?.fields?.durationMs).toBe("number");
  });

  it("never logs the query string (tokens and PII routinely live there)", () => {
    const { client, logs } = mockClient();
    const bb = createExpressIntegration(client, { logRequests: true });
    const res = fakeResponse(200);
    bb.requestHandler(
      { method: "GET", originalUrl: "/search?token=SECRET&email=a@b.com" } as never,
      res as never,
      () => {},
    );
    res.emit("finish");
    expect(logs[0]?.fields?.path).toBe("/search");
    expect(JSON.stringify(logs[0])).not.toContain("SECRET");
  });

  it("maps status to level: 2xx/3xx info, 4xx warn, 5xx error", () => {
    const { client, logs } = mockClient();
    const bb = createExpressIntegration(client, { logRequests: true });
    for (const status of [200, 302, 404, 500]) {
      const res = fakeResponse(status);
      bb.requestHandler({ method: "GET", url: "/x" } as never, res as never, () => {});
      res.emit("finish");
    }
    expect(logs.map((l) => l.level)).toEqual(["info", "info", "warn", "error"]);
  });

  it("stamps the request's trace id on the line (the link from an error to its logs)", () => {
    const { client, logs } = mockClient();
    const bb = createExpressIntegration(client, { logRequests: true });
    const res = fakeResponse(200);
    bb.requestHandler(
      { method: "GET", url: "/x", requestId: "trace-abc" } as never,
      res as never,
      () => {},
    );
    res.emit("finish");
    expect(logs[0]?.traceId).toBe("trace-abc");
  });

  it("skips ignorePaths (health probes)", () => {
    const { client, logs } = mockClient();
    const bb = createExpressIntegration(client, { logRequests: { ignorePaths: ["/healthz"] } });
    for (const url of ["/healthz", "/real"]) {
      const res = fakeResponse(200);
      bb.requestHandler({ method: "GET", url } as never, res as never, () => {});
      res.emit("finish");
    }
    expect(logs.map((l) => l.fields?.path)).toEqual(["/real"]);
  });

  it("a request log line does NOT count as 'captured': a 5xx still gets its HandledHttpError", () => {
    const { client, logs, exceptions } = mockClient();
    const bb = createExpressIntegration(client, { logRequests: true });
    const res = fakeResponse(500);
    bb.requestHandler({ method: "GET", route: { path: "/boom" } } as never, res as never, () => {
      bb.log.info("about to fail"); // an ordinary log inside the request
    });
    res.emit("finish");
    expect(exceptions).toHaveLength(1);
    expect(logs.map((l) => l.level)).toEqual(["info", "error"]);
  });

  it("is a harmless no-op against a client that has no captureLog (older client)", () => {
    const bb = createExpressIntegration(
      { captureException: () => {}, captureMessage: () => {} },
      { logRequests: true },
    );
    const res = fakeResponse(200);
    bb.requestHandler({ method: "GET", url: "/x" } as never, res as never, () => {});
    expect(() => res.emit("finish")).not.toThrow();
    expect(() => bb.log.info("x")).not.toThrow();
  });
});

describe("express instrumentConsole({ logs: true })", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  it("leaves console.log/info/debug completely untouched by default", () => {
    const { client } = mockClient();
    const bb = createExpressIntegration(client);
    const before = [console.log, console.info, console.debug];
    restore = bb.instrumentConsole();
    expect([console.log, console.info, console.debug]).toEqual(before);
  });

  it("records console.log/info/debug/warn/error as info/info/debug/warn/error lines", () => {
    const { client, logs } = mockClient();
    const bb = createExpressIntegration(client);
    const originals = {
      log: console.log,
      info: console.info,
      debug: console.debug,
      warn: console.warn,
      error: console.error,
    };
    console.log = console.info = console.debug = console.warn = console.error = () => {};
    const innerOriginals = { log: console.log, warn: console.warn, error: console.error };
    restore = bb.instrumentConsole({ logs: true });

    console.log("user %s signed in", "alice");
    console.info("info line");
    console.debug("debug line");
    console.warn("warn line");
    console.error("error line");
    restore();
    restore = undefined;
    Object.assign(console, originals);

    expect(logs.map((l) => [l.level, l.message])).toEqual([
      ["info", "user alice signed in"],
      ["info", "info line"],
      ["debug", "debug line"],
      ["warn", "warn line"],
      ["error", "error line"],
    ]);
    expect(innerOriginals.log).toBeDefined();
  });

  it("still calls the original console method (output is never swallowed)", () => {
    const { client } = mockClient();
    const bb = createExpressIntegration(client);
    const printed: unknown[][] = [];
    const saved = console.log;
    console.log = (...args: unknown[]) => void printed.push(args);
    restore = bb.instrumentConsole({ logs: true });
    console.log("hello", 1);
    restore();
    restore = undefined;
    console.log = saved;
    expect(printed).toEqual([["hello", 1]]);
  });

  it("restores every console method it touched", () => {
    const { client } = mockClient();
    const bb = createExpressIntegration(client);
    const before = {
      log: console.log,
      info: console.info,
      debug: console.debug,
      warn: console.warn,
      error: console.error,
    };
    restore = bb.instrumentConsole({ logs: true });
    expect(console.log).not.toBe(before.log);
    restore();
    restore = undefined;
    expect({
      log: console.log,
      info: console.info,
      debug: console.debug,
      warn: console.warn,
      error: console.error,
    }).toEqual(before);
  });

  it("does not throw into the host's console call when formatting a hostile object", () => {
    const { client } = mockClient();
    const bb = createExpressIntegration(client);
    const saved = console.log;
    console.log = () => {};
    restore = bb.instrumentConsole({ logs: true });
    const hostile = {
      get boom(): never {
        throw new Error("x");
      },
      toString() {
        throw new Error("y");
      },
    };
    expect(() => console.log(hostile)).not.toThrow();
    restore();
    restore = undefined;
    console.log = saved;
  });
});
