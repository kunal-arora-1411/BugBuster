import { connect } from "node:net";
import { existsSync } from "node:fs";
import type { Directives } from "@bugbuster/types";
import type { Transport } from "./transport.js";
import { TransportError } from "./transport.js";

/**
 * The required v1 backend path (ingest-pipeline.md §6): write to the Agent's Unix domain socket
 * (or Windows named pipe — Node's `net` module exposes both through the same API), then forget.
 * No TLS, no compression, no retries, no circuit breaker — all of that is the Agent's job.
 *
 * KNOWN v1 GAP, stated plainly rather than glossed over: this protocol is one-way. The SDK opens
 * a connection, writes one batch, and the Agent closes the connection once it has fully received
 * the bytes — there is no response channel for the Agent to push backend directives back down.
 * Concretely: `send()` always resolves with `directives: undefined`. A real SDK running behind an
 * Agent does not yet obey `X-BB-Sample-Directive`/`X-BB-Suppress-Fingerprints` the way one running
 * in direct mode does — only HttpTransport gets synchronous directives today, because only it
 * talks straight to the backend. Fixing this needs a real design decision (the Agent pushing
 * directives to connected SDKs, or the SDK pulling them on its next connection) — deliberately not
 * built speculatively here; flagged instead so it isn't mistaken for "already working."
 */
export interface UdsTransportOptions {
  socketPath: string;
}

export function isAgentSocketAvailable(socketPath: string): boolean {
  // Windows named pipes aren't regular filesystem entries `existsSync` can see; POSIX sockets are.
  if (socketPath.startsWith("\\\\.\\pipe\\")) return true;
  return existsSync(socketPath);
}

export class UdsTransport implements Transport {
  constructor(private readonly options: UdsTransportOptions) {}

  send(payload: Buffer): Promise<Directives | undefined> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.options.socketPath);
      socket.on("connect", () => socket.end(payload));
      socket.on("close", (hadError) => {
        if (hadError) reject(new TransportError("agent connection closed with an error", true));
        else resolve(undefined); // see the class doc — no directive channel over UDS yet
      });
      socket.on("error", (err) => reject(new TransportError(err.message, true)));
    });
  }
}
