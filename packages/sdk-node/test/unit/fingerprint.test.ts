import { describe, expect, it } from "vitest";
import { computeCoarsenedFingerprint, computeFingerprint } from "../../src/worker/fingerprint.js";
import { parseStack } from "../../src/worker/stack.js";

const STACK_A = [
  "PaymentTimeout: provider did not respond",
  "    at PaymentService.createPayment (payment.service.ts:142:11)",
  "    at Object.<anonymous> (index.ts:10:3)",
].join("\n");

const STACK_A_DIFFERENT_DEPLOY_PATH = [
  "PaymentTimeout: provider did not respond",
  "    at PaymentService.createPayment (/build/x9f2/payment.service.ts:142:11)",
  "    at Object.<anonymous> (/build/x9f2/index.ts:10:3)",
].join("\n");

const STACK_B_DIFFERENT_FUNCTION = [
  "PaymentTimeout: provider did not respond",
  "    at OrderService.retry (order.service.ts:80:5)",
].join("\n");

describe("computeFingerprint", () => {
  it("produces identical fingerprints for the same type+stack+function regardless of deploy path prefix", () => {
    const fpA = computeFingerprint({ errorType: "PaymentTimeout", frames: parseStack(STACK_A) });
    const fpB = computeFingerprint({
      errorType: "PaymentTimeout",
      frames: parseStack(STACK_A_DIFFERENT_DEPLOY_PATH),
    });
    expect(fpA).toBe(fpB);
  });

  it("produces different fingerprints when the throwing function differs", () => {
    const fpA = computeFingerprint({ errorType: "PaymentTimeout", frames: parseStack(STACK_A) });
    const fpB = computeFingerprint({
      errorType: "PaymentTimeout",
      frames: parseStack(STACK_B_DIFFERENT_FUNCTION),
    });
    expect(fpA).not.toBe(fpB);
  });

  it("is deterministic across repeated calls on identical input", () => {
    const input = { errorType: "PaymentTimeout", frames: parseStack(STACK_A) };
    expect(computeFingerprint(input)).toBe(computeFingerprint(input));
  });

  it("produces a stable, fixed-length identifier across a range of valid stack depths", () => {
    const shallow = computeFingerprint({
      errorType: "Err",
      frames: parseStack("Err: x\n    at f (a.ts:1:1)"),
    });
    const deepStackLines = Array.from(
      { length: 50 },
      (_, i) => `    at fn${i} (file${i}.ts:${i + 1}:1)`,
    );
    const deep = computeFingerprint({
      errorType: "Err",
      frames: parseStack(["Err: x", ...deepStackLines].join("\n")),
    });
    expect(shallow).toMatch(/^fp_[0-9a-f]{16}$/);
    expect(deep).toMatch(/^fp_[0-9a-f]{16}$/);
  });
});

describe("computeCoarsenedFingerprint", () => {
  it("collides two related-but-distinct stacks that share the same innermost (throw-site) frame once truncated to depth 1", () => {
    // computeCoarsenedFingerprint keeps the N frames CLOSEST to the throw site (frames[0..N)),
    // matching the doc's "innermost entry point at a given (uncoarsened) depth" primaryFunction
    // rule — so two stacks sharing frame[0] but diverging further up the call chain collide once
    // truncated to depth 1.
    const stackX = "Err: x\n    at sharedInner (db.ts:5:1)\n    at outerA (serviceA.ts:20:1)";
    const stackY = "Err: x\n    at sharedInner (db.ts:5:1)\n    at outerB (serviceB.ts:30:1)";
    const coarseX = computeCoarsenedFingerprint(
      { errorType: "Err", frames: parseStack(stackX) },
      1,
    );
    const coarseY = computeCoarsenedFingerprint(
      { errorType: "Err", frames: parseStack(stackY) },
      1,
    );
    expect(coarseX).toBe(coarseY); // both collapse to just the shared "sharedInner" frame
  });
});
