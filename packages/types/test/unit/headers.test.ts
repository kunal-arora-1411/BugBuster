import { describe, expect, it } from "vitest";
import {
  DirectivesSchema,
  HEADER_CONFIG_VERSION,
  HEADER_RETRY_AFTER,
  HEADER_SAMPLE_DIRECTIVE,
  HEADER_SUPPRESS_FINGERPRINTS,
  SampleDirectiveSchema,
} from "../../src/headers.js";

describe("header name constants", () => {
  it("match the wire contract verbatim (ingest-pipeline.md §7.1)", () => {
    expect(HEADER_SAMPLE_DIRECTIVE).toBe("X-BB-Sample-Directive");
    expect(HEADER_SUPPRESS_FINGERPRINTS).toBe("X-BB-Suppress-Fingerprints");
    expect(HEADER_RETRY_AFTER).toBe("X-BB-Retry-After");
    expect(HEADER_CONFIG_VERSION).toBe("X-BB-Config-Version");
  });
});

describe("SampleDirectiveSchema", () => {
  it("accepts the documented example directive", () => {
    const result = SampleDirectiveSchema.safeParse({ error: 1.0, log: 0.02, span: 0.005 });
    expect(result.success).toBe(true);
  });

  it("accepts all-1.0 (no sampling — the pilot-scale default)", () => {
    expect(SampleDirectiveSchema.safeParse({ error: 1, log: 1, span: 1 }).success).toBe(true);
  });
});

describe("DirectivesSchema", () => {
  it("accepts a fully valid directive set", () => {
    const result = DirectivesSchema.safeParse({
      sample: { error: 1.0, log: 0.02, span: 0.005 },
      suppressFingerprints: ["fp_a1b2c3"],
      retryAfterSeconds: 30,
      configVersion: 42,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid directive set with no suppression active", () => {
    const result = DirectivesSchema.safeParse({
      sample: { error: 1, log: 1, span: 1 },
      suppressFingerprints: [],
      configVersion: 1,
    });
    expect(result.success).toBe(true);
  });
});
