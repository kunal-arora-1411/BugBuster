import { describe, expect, it } from "vitest";
import { IssueSchema, FoldDeltaSchema } from "../../src/issue.js";

function validIssue() {
  return {
    fingerprint: "fp_a1b2c3",
    count: 41200,
    usersAffected: 6921,
    duration: { p50: 120, p95: 800, p99: 30200 },
    topEndpoints: {
      top: [{ endpoint: "/checkout", count: 41000 }],
      other: 200,
    },
    releases: ["2.8.1"],
    firstSeen: new Date(0).toISOString(),
    lastSeen: new Date().toISOString(),
    exemplarRefs: [{ eventId: "evt_1", role: "first" as const }],
    adjustedCount: 1.0,
  };
}

describe("IssueSchema", () => {
  it("accepts a valid fold/aggregate record", () => {
    expect(IssueSchema.safeParse(validIssue()).success).toBe(true);
  });

  it("defaults adjustedCount to 1.0 when omitted", () => {
    const { adjustedCount: _omit, ...rest } = validIssue();
    const parsed = IssueSchema.parse(rest);
    expect(parsed.adjustedCount).toBe(1.0);
  });

  it("accepts an issue with the exemplar cap (6) fully populated", () => {
    const withSixExemplars = {
      ...validIssue(),
      exemplarRefs: Array.from({ length: 6 }, (_, i) => ({
        eventId: `evt_${i}`,
        role: "one-novel-stack" as const,
      })),
    };
    expect(IssueSchema.safeParse(withSixExemplars).success).toBe(true);
  });

  it("accepts an issue with no releases yet (freshly created)", () => {
    expect(IssueSchema.safeParse({ ...validIssue(), releases: [] }).success).toBe(true);
  });
});

describe("FoldDeltaSchema", () => {
  it("accepts a valid single-window fold delta", () => {
    const delta = {
      fingerprint: "fp_a1b2c3",
      windowStart: new Date(0).toISOString(),
      windowEnd: new Date().toISOString(),
      count: 100,
      userIds: ["u1", "u2", "u3"],
      endpointCounts: { "/checkout": 95, "/retry": 5 },
      durationSamplesMs: [120, 140, 30200],
      release: "2.8.1",
      exemplars: ["evt_1", "evt_2"],
    };
    expect(FoldDeltaSchema.safeParse(delta).success).toBe(true);
  });

  it("accepts a valid fold delta with no release known yet", () => {
    const delta = {
      fingerprint: "fp_a1b2c3",
      windowStart: new Date(0).toISOString(),
      windowEnd: new Date().toISOString(),
      count: 1,
      userIds: ["u1"],
      endpointCounts: {},
      durationSamplesMs: [50],
      exemplars: [],
    };
    expect(FoldDeltaSchema.safeParse(delta).success).toBe(true);
  });
});
