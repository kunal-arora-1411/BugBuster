import { connect } from "node:net";
import { existsSync } from "node:fs";
import type { Directives } from "@bugbusterhq/types";
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

/**
 * KNOWN v1 GAP, Windows-specific: named pipes aren't regular filesystem entries `existsSync` can
 * see, so any `\\.\pipe\...`-shaped path is unconditionally reported available — there is no
 * synchronous way to actually probe a Windows pipe (a real check needs an async connect attempt,
 * and `init()` is deliberately synchronous). Two consequences: (1) `init()` always picks
 * UdsTransport on Windows once a pipe-shaped path is configured, even if nothing is listening yet
 * at startup; (2) if a Windows Agent that WAS running crashes mid-process, this function still
 * reports it available on every subsequent flush — the SDK keeps selecting UdsTransport, whose
 * sends then fail and get silently dropped (§3.4/§7.2's "never throw out of the flush loop"),
 * rather than ever falling back to HttpTransport. On POSIX this function is a correct, real check
 * (UDS paths genuinely are filesystem entries). Fixing the Windows case for real needs either an
 * async re-probe on a failure streak or making transport selection re-evaluated per-flush instead
 * of once at init() — not built speculatively here; flagged instead.
 */
export function isAgentSocketAvailable(socketPath: string): boolean {
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
