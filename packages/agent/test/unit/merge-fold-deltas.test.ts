import { describe, expect, it } from "vitest";
import { mergeFoldDeltas } from "../../src/merge-fold-deltas.js";
import type { FoldDelta } from "@bugbuster/types";

function delta(overrides: Partial<FoldDelta>): FoldDelta {
  return {
    fingerprint: "fp_a",
    windowStart: new Date(0).toISOString(),
    windowEnd: new Date().toISOString(),
    count: 1,
    userIds: [],
    endpointCounts: {},
    durationSamplesMs: [],
    exemplars: [],
    ...overrides,
  };
}

describe("mergeFoldDeltas — cross-process fold (the Agent's reason to exist)", () => {
  it("merges two SDK clients reporting the same valid fingerprint into one combined aggregate", () => {
    const fromServiceA = delta({ count: 40, userIds: ["u1", "u2"] });
    const fromServiceB = delta({ count: 60, userIds: ["u2", "u3"] });
    const merged = mergeFoldDeltas([fromServiceA, fromServiceB]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.count).toBe(100);
    expect(new Set(merged[0]?.userIds).size).toBe(3); // u2 deduplicated across both services
  });

  it("keeps distinct fingerprints as separate merged entries", () => {
    const a = delta({ fingerprint: "fp_a", count: 5 });
    const b = delta({ fingerprint: "fp_b", count: 7 });
    const merged = mergeFoldDeltas([a, b]);
    expect(merged).toHaveLength(2);
  });

  it("sums endpoint counts across services for the same fingerprint", () => {
    const a = delta({ endpointCounts: { "/checkout": 10 } });
    const b = delta({ endpointCounts: { "/checkout": 5, "/retry": 2 } });
    const merged = mergeFoldDeltas([a, b]);
    expect(merged[0]?.endpointCounts).toEqual({ "/checkout": 15, "/retry": 2 });
  });

  it("concatenates duration samples and exemplar references across services", () => {
    const a = delta({ durationSamplesMs: [10, 20], exemplars: ["evt_a1"] });
    const b = delta({ durationSamplesMs: [30], exemplars: ["evt_b1", "evt_b2"] });
    const merged = mergeFoldDeltas([a, b]);
    expect(merged[0]?.durationSamplesMs).toEqual([10, 20, 30]);
    expect(merged[0]?.exemplars).toEqual(["evt_a1", "evt_b1", "evt_b2"]);
  });

  it("widens the window to cover the earliest start and latest end across services", () => {
    const a = delta({
      windowStart: "2026-01-01T00:00:00.000Z",
      windowEnd: "2026-01-01T00:00:05.000Z",
    });
    const b = delta({
      windowStart: "2026-01-01T00:00:02.000Z",
      windowEnd: "2026-01-01T00:00:10.000Z",
    });
    const merged = mergeFoldDeltas([a, b]);
    expect(merged[0]?.windowStart).toBe("2026-01-01T00:00:00.000Z");
    expect(merged[0]?.windowEnd).toBe("2026-01-01T00:00:10.000Z");
  });
});
