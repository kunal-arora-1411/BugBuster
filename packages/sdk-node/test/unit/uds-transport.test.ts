import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { isAgentSocketAvailable, UdsTransport } from "../../src/transport/uds-transport.js";

function freshSocketPath(): string {
  const id = `bugbuster-sdk-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  return platform === "win32" ? `\\\\.\\pipe\\${id}` : join(tmpdir(), `${id}.sock`);
}

let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

describe("UdsTransport", () => {
  it("delivers a valid batch's exact bytes to a real local Agent-like listener", async () => {
    const socketPath = freshSocketPath();
    const received: Buffer[] = [];
    server = createServer((socket) => {
      const chunks: Buffer[] = [];
      socket.on("data", (c: Buffer) => chunks.push(c));
      socket.on("end", () => received.push(Buffer.concat(chunks)));
    });
    await new Promise<void>((resolve) => server?.listen(socketPath, resolve));

    const transport = new UdsTransport({ socketPath });
    const result = await transport.send(Buffer.from("hello agent"));

    expect(result).toBeUndefined(); // no directive channel over UDS yet — see the class doc
    expect(received[0]?.toString()).toBe("hello agent");
  });

  it("rejects when no Agent is listening at the configured path", async () => {
    const transport = new UdsTransport({ socketPath: freshSocketPath() }); // nothing listens here
    await expect(transport.send(Buffer.from("x"))).rejects.toBeTruthy();
  });
});

describe("isAgentSocketAvailable", () => {
  it("returns false for a POSIX socket path that does not exist", () => {
    if (platform === "win32") return; // named pipes aren't filesystem-visible; skip on Windows
    expect(isAgentSocketAvailable(freshSocketPath())).toBe(false);
  });
});
