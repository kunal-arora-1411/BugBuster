import type { Directives } from "@bugbuster/types";

/**
 * The seam ingest-pipeline.md §6.3 requires: the capture/fold pipeline talks to this interface,
 * never to a transport implementation directly. UdsTransport (the required v1 backend path) and
 * HttpTransport (the browser/mobile/serverless fallback, and this package's dev/test harness
 * before an Agent exists) are equally valid implementations from the pipeline's point of view.
 */
export interface Transport {
  /**
   * Sends one already-serialized batch. Must never throw for a valid input — network failure is
   * reported as a rejected promise with a `TransportError`, which the caller (the flush loop)
   * turns into a counted drop, not an unhandled exception.
   */
  send(payload: Buffer): Promise<Directives | undefined>;
}

export class TransportError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "TransportError";
  }
}
