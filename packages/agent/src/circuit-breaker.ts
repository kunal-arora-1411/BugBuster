/**
 * CLOSED / OPEN / HALF-OPEN (ingest-pipeline.md §7.2, glossary §6, blueprint plate 05B). Protects
 * the host from the Agent hammering an unreachable backend: while OPEN, `guard()` fails instantly
 * without attempting a network call at all — attempting per-batch connections to a backend that's
 * guaranteed to fail burns sockets and threads for nothing.
 */
export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  now?: () => number;
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private halfOpenProbeInFlight = false;
  private readonly now: () => number;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.now = options.now ?? Date.now;
  }

  getState(): CircuitState {
    if (this.state === "open" && this.now() - this.openedAt >= this.options.cooldownMs) {
      this.state = "half-open";
    }
    return this.state;
  }

  /** True if a call may proceed right now (and, for half-open, claims the single probe slot). */
  canAttempt(): boolean {
    const state = this.getState();
    if (state === "closed") return true;
    if (state === "half-open" && !this.halfOpenProbeInFlight) {
      this.halfOpenProbeInFlight = true;
      return true;
    }
    return false; // OPEN, or a half-open probe is already in flight — fail instantly, no network call
  }

  onSuccess(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.halfOpenProbeInFlight = false;
  }

  onFailure(): void {
    this.halfOpenProbeInFlight = false;
    if (this.state === "half-open") {
      // Probe failed — back off again, full cooldown restarts.
      this.state = "open";
      this.openedAt = this.now();
      return;
    }
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.options.failureThreshold) {
      this.state = "open";
      this.openedAt = this.now();
    }
  }
}
