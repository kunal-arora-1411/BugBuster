import { describe, expect, it } from "vitest";
import { attachFidelity } from "../../src/query/fidelity.js";
import type { Issue } from "@bugbuster/types";

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    fingerprint: "fp_a",
    count: 100,
    usersAffected: 10,
    duration: { p50: 10, p95: 20, p99: 30 },
    topEndpoints: { top: [], other: 0 },
    releases: [],
    firstSeen: new Date(0).toISOString(),
    lastSeen: new Date().toISOString(),
    exemplarRefs: [],
    adjustedCount: 1.0,
    ...overrides,
  };
}

describe("attachFidelity", () => {
  it("marks an unsampled issue (adjustedCount === 1.0) as exact", () => {
    const result = attachFidelity(issue({ adjustedCount: 1.0 }));
    expect(result.fidelity.isExact).toBe(true);
  });

  it("marks a sampled issue (adjustedCount !== 1.0) as not exact, never presenting it as absolute truth", () => {
    const result = attachFidelity(issue({ adjustedCount: 20 }));
    expect(result.fidelity.isExact).toBe(false);
    expect(result.fidelity.adjustedCount).toBe(20);
  });
});
