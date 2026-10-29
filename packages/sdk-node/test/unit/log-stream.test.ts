import { describe, expect, it } from "vitest";
import type { LogLevel } from "@bugbusterhq/types";
import { createLogStream } from "../../src/integrations/log-stream.js";

function setup() {
  const calls: { level: LogLevel; message: string; fields?: Record<string, unknown> }[] = [];
  const stream = createLogStream({
    captureLog: (level, message, fields) => void calls.push({ level, message, fields }),
  });
  return { stream, calls };
}

describe("createLogStream", () => {
  it("understands pino lines: numeric level, msg, and extra keys become fields", () => {
    const { stream, calls } = setup();
    stream.write(
      JSON.stringify({
        level: 40,
        time: 1,
        pid: 9,
        hostname: "h",
        msg: "disk almost full",
        pct: 93,
      }) + "\n",
    );
    expect(calls).toEqual([{ level: "warn", message: "disk almost full", fields: { pct: 93 } }]);
  });

  it("maps every pino level band", () => {
    const { stream, calls } = setup();
    for (const level of [10, 20, 30, 40, 50, 60])
      stream.write(JSON.stringify({ level, msg: "m" }) + "\n");
    expect(calls.map((c) => c.level)).toEqual(["debug", "debug", "info", "warn", "error", "error"]);
  });

  it("understands winston lines: string level and message", () => {
    const { stream, calls } = setup();
    stream.write(
      JSON.stringify({ level: "error", message: "payment failed", orderId: "o_9" }) + "\n",
    );
    stream.write(JSON.stringify({ level: "verbose", message: "v" }) + "\n");
    expect(calls[0]).toEqual({
      level: "error",
      message: "payment failed",
      fields: { orderId: "o_9" },
    });
    expect(calls[1]?.level).toBe("debug");
  });

  it("records a non-JSON line verbatim at the default level", () => {
    const { stream, calls } = setup();
    stream.write("plain text line\n");
    expect(calls).toEqual([{ level: "info", message: "plain text line", fields: undefined }]);
  });

  it("reassembles a line split across chunks, and handles several lines in one chunk", () => {
    const { stream, calls } = setup();
    const line = JSON.stringify({ level: 30, msg: "split across chunks" });
    stream.write(line.slice(0, 10));
    stream.write(line.slice(10) + "\n" + JSON.stringify({ level: 30, msg: "second" }) + "\n");
    expect(calls.map((c) => c.message)).toEqual(["split across chunks", "second"]);
  });

  it("flushes an unterminated final line on end()", async () => {
    const { stream, calls } = setup();
    stream.write(JSON.stringify({ level: 30, msg: "no trailing newline" }));
    await new Promise<void>((resolve) => stream.end(resolve));
    expect(calls.map((c) => c.message)).toEqual(["no trailing newline"]);
  });

  it("ignores blank lines and tolerates JSON that is not an object", () => {
    const { stream, calls } = setup();
    stream.write("\n   \n42\n[1,2]\n");
    expect(calls.map((c) => c.message)).toEqual(["42", "[1,2]"]);
  });

  it("uses a placeholder when a structured line carries no message", () => {
    const { stream, calls } = setup();
    stream.write(JSON.stringify({ level: 30, userId: "u1" }) + "\n");
    expect(calls[0]).toMatchObject({ message: "(no message)", fields: { userId: "u1" } });
  });
});
