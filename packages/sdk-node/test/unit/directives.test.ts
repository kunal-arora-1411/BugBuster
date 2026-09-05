import { describe, expect, it } from "vitest";
import { createSampler } from "../../src/sampler.js";
import { SuppressionState, applyDirectives } from "../../src/directives.js";

describe("applyDirectives — sampler obedience", () => {
  it("a valid X-BB-Sample-Directive response updates subsequent in-process sampling rates", () => {
    const sampler = createSampler({ error: 1, log: 1, span: 1 });
    const suppression = new SuppressionState();
    applyDirectives(
      { sample: { error: 1, log: 0.02, span: 0.005 }, suppressFingerprints: [], configVersion: 1 },
      sampler,
      suppression,
    );
    expect(sampler.getRates()).toEqual({ error: 1, log: 0.02, span: 0.005 });
  });
});

describe("SuppressionState — per-fingerprint suppression", () => {
  it("a valid suppress list marks the matching fingerprint suppressed for the 10-minute window", () => {
    const suppression = new SuppressionState();
    const now = Date.now();
    suppression.applyList(["fp_a1b2c3"], now);
    expect(suppression.isSuppressed("fp_a1b2c3", now)).toBe(true);
    expect(suppression.isSuppressed("fp_a1b2c3", now + 9 * 60 * 1000)).toBe(true);
  });

  it("suppression expires after the 10-minute window elapses", () => {
    const suppression = new SuppressionState();
    const now = Date.now();
    suppression.applyList(["fp_a1b2c3"], now);
    expect(suppression.isSuppressed("fp_a1b2c3", now + 11 * 60 * 1000)).toBe(false);
  });

  it("does not suppress a fingerprint that was never listed", () => {
    const suppression = new SuppressionState();
    suppression.applyList(["fp_other"], Date.now());
    expect(suppression.isSuppressed("fp_a1b2c3")).toBe(false);
  });
});
