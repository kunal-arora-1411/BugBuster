import { describe, expect, it } from "vitest";
import { FoldTable, COARSENED_KEY, MAX_EXEMPLARS_PER_ISSUE } from "../../src/worker/fold.js";
import type { BugBusterEvent } from "@bugbuster/types";

function makeEvent(overrides: Partial<BugBusterEvent> = {}): BugBusterEvent {
  return {
    eventId: overrides.eventId ?? `evt_${Math.random().toString(36).slice(2)}`,
    fingerprint: "fp_test",
    exemplarRole: "first",
    timestamp: new Date().toISOString(),
    type: "exception",
    trace: { traceId: "t", spanId: "s" },
    service: { name: "svc", version: "1.0.0", environment: "production" },
    source: { function: "f", file: "f.ts", line: 1 },
    error: { type: "Err", message: "boom", stacktrace: "Err: boom" },
    ...overrides,
  };
}

describe("FoldTable — exact aggregation (v1)", () => {
  it("folds 100 valid same-fingerprint occurrences into count === 100 exactly", () => {
    const table = new FoldTable(10_000);
    for (let i = 0; i < 100; i++) {
      table.record({
        fingerprint: "fp_a",
        isNewFingerprint: i === 0,
        event: makeEvent({ eventId: `evt_${i}`, fingerprint: "fp_a" }),
      });
    }
    const { deltas } = table.drain();
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.count).toBe(100);
  });

  it("computes usersAffected as the exact deduplicated cardinality of user IDs seen", () => {
    const table = new FoldTable(10_000);
    const userSequence = ["u1", "u2", "u1", "u3", "u2", "u1"]; // 3 distinct users, with repeats
    userSequence.forEach((userId, i) => {
      table.record({
        fingerprint: "fp_a",
        isNewFingerprint: i === 0,
        userId,
        event: makeEvent({ eventId: `evt_${i}`, fingerprint: "fp_a" }),
      });
    });
    const { deltas } = table.drain();
    expect(new Set(deltas[0]?.userIds).size).toBe(3);
  });

  it("tracks per-endpoint frequency for top-K ranking downstream", () => {
    const table = new FoldTable(10_000);
    const endpoints = ["/checkout", "/checkout", "/checkout", "/retry"];
    endpoints.forEach((endpoint, i) => {
      table.record({
        fingerprint: "fp_a",
        isNewFingerprint: i === 0,
        endpoint,
        event: makeEvent({ eventId: `evt_${i}`, fingerprint: "fp_a" }),
      });
    });
    const { deltas } = table.drain();
    expect(deltas[0]?.endpointCounts).toEqual({ "/checkout": 3, "/retry": 1 });
  });
});

describe("FoldTable — exemplar policy", () => {
  it("selects first, last, and slowest as distinct exemplars for a valid batch with a clear ordering", () => {
    const table = new FoldTable(10_000);
    const first = makeEvent({ eventId: "evt_first", fingerprint: "fp_a" });
    const middleSlow = makeEvent({ eventId: "evt_slow", fingerprint: "fp_a" });
    const last = makeEvent({ eventId: "evt_last", fingerprint: "fp_a" });

    table.record({ fingerprint: "fp_a", isNewFingerprint: true, durationMs: 10, event: first });
    table.record({
      fingerprint: "fp_a",
      isNewFingerprint: false,
      durationMs: 9999,
      event: middleSlow,
    });
    table.record({ fingerprint: "fp_a", isNewFingerprint: false, durationMs: 15, event: last });

    const { exemplars } = table.drain();
    const ids = exemplars.map((e) => e.eventId);
    expect(ids).toContain("evt_first");
    expect(ids).toContain("evt_slow");
    expect(ids).toContain("evt_last");
  });

  it("caps total exemplars per issue at MAX_EXEMPLARS_PER_ISSUE even with many candidate roles", () => {
    const table = new FoldTable(10_000);
    // one novel-stack + many distinct releases, each contributing a candidate exemplar
    table.record({
      fingerprint: "fp_a",
      isNewFingerprint: true,
      release: "1.0.0",
      event: makeEvent({ eventId: "evt_novel", fingerprint: "fp_a" }),
    });
    for (let i = 1; i <= 10; i++) {
      table.record({
        fingerprint: "fp_a",
        isNewFingerprint: false,
        release: `1.${i}.0`,
        event: makeEvent({ eventId: `evt_release_${i}`, fingerprint: "fp_a" }),
      });
    }
    const { exemplars } = table.drain();
    expect(exemplars.length).toBeLessThanOrEqual(MAX_EXEMPLARS_PER_ISSUE);
  });

  it("marks the very first occurrence of a brand-new fingerprint with the one-novel-stack role", () => {
    const table = new FoldTable(10_000);
    table.record({
      fingerprint: "fp_new",
      isNewFingerprint: true,
      event: makeEvent({ eventId: "evt_1", fingerprint: "fp_new" }),
    });
    const { exemplars } = table.drain();
    expect(exemplars.find((e) => e.eventId === "evt_1")?.exemplarRole).toBe("one-novel-stack");
  });
});

describe("FoldTable — cardinality cap under storm (§4.5)", () => {
  it("coarsens rather than growing unbounded once maxLiveFingerprints is exceeded", () => {
    const maxLive = 10;
    const table = new FoldTable(maxLive);
    for (let i = 0; i < maxLive + 50; i++) {
      table.record({
        fingerprint: `fp_distinct_${i}`,
        isNewFingerprint: true,
        event: makeEvent({ eventId: `evt_${i}`, fingerprint: `fp_distinct_${i}` }),
      });
    }
    // maxLive genuinely distinct fingerprints, PLUS the coarsened overflow bucket itself as one
    // more entry — the guarantee is "bounded", not "exactly maxLive": 11 here, never 60.
    expect(table.liveFingerprintCount).toBeLessThanOrEqual(maxLive + 1);

    const { deltas } = table.drain();
    const coarsened = deltas.find((d) => d.fingerprint === COARSENED_KEY);
    expect(coarsened).toBeDefined();
    expect(coarsened?.count).toBeGreaterThan(1); // multiple overflow fingerprints merged into it
  });
});
