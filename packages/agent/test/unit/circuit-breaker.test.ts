import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../../src/circuit-breaker.js";

function harness(now = { value: 0 }) {
  const breaker = new CircuitBreaker({
    failureThreshold: 5,
    cooldownMs: 30_000,
    now: () => now.value,
  });
  return { breaker, now };
}

describe("CircuitBreaker", () => {
  it("starts CLOSED and allows attempts", () => {
    const { breaker } = harness();
    expect(breaker.getState()).toBe("closed");
    expect(breaker.canAttempt()).toBe(true);
  });

  it("trips to OPEN after 5 consecutive valid-request failures", () => {
    const { breaker } = harness();
    for (let i = 0; i < 5; i++) breaker.onFailure();
    expect(breaker.getState()).toBe("open");
  });

  it("fails instantly (canAttempt() === false) while OPEN, before the cooldown elapses", () => {
    const { breaker, now } = harness();
    for (let i = 0; i < 5; i++) breaker.onFailure();
    now.value += 1000; // well short of the 30s cooldown
    expect(breaker.canAttempt()).toBe(false);
  });

  it("transitions to HALF-OPEN and allows exactly one probe once the cooldown elapses", () => {
    const { breaker, now } = harness();
    for (let i = 0; i < 5; i++) breaker.onFailure();
    now.value += 30_000;
    expect(breaker.getState()).toBe("half-open");
    expect(breaker.canAttempt()).toBe(true); // the one probe
    expect(breaker.canAttempt()).toBe(false); // a second concurrent attempt is not a second probe
  });

  it("a successful HALF-OPEN probe transitions back to CLOSED and resumes normal sends", () => {
    const { breaker, now } = harness();
    for (let i = 0; i < 5; i++) breaker.onFailure();
    now.value += 30_000;
    breaker.canAttempt(); // claim the probe
    breaker.onSuccess();
    expect(breaker.getState()).toBe("closed");
    expect(breaker.canAttempt()).toBe(true);
  });

  it("a failed HALF-OPEN probe reopens the breaker for a full new cooldown", () => {
    const { breaker, now } = harness();
    for (let i = 0; i < 5; i++) breaker.onFailure();
    now.value += 30_000;
    breaker.canAttempt();
    breaker.onFailure();
    expect(breaker.getState()).toBe("open");
    now.value += 1000;
    expect(breaker.canAttempt()).toBe(false); // still cooling down from the new open
  });
});
