import { describe, expect, it } from "vitest";
import { BugBusterEventSchema } from "../../src/event.js";

function validExceptionEvent() {
  return {
    eventId: "evt_1",
    fingerprint: "fp_a1b2c3",
    exemplarRole: "first" as const,
    timestamp: new Date().toISOString(),
    type: "exception" as const,
    trace: { traceId: "7f92ab", spanId: "001" },
    service: { name: "payment-service", version: "2.4.1", environment: "production" },
    source: { function: "PaymentService.createPayment", file: "payment.service.ts", line: 142 },
    error: {
      type: "PaymentTimeout",
      code: "PAYMENT_PROVIDER_TIMEOUT",
      message: "provider did not respond",
      stacktrace: "PaymentTimeout: ...\n  at PaymentService.createPayment (payment.service.ts:142)",
    },
  };
}

describe("BugBusterEventSchema", () => {
  it("accepts a valid exception exemplar (doc.md's event model, adapted)", () => {
    const result = BugBusterEventSchema.safeParse(validExceptionEvent());
    expect(result.success).toBe(true);
  });

  it("accepts a valid message event with no error block", () => {
    const evt = validExceptionEvent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: _omit, ...rest } = evt as any;
    const result = BugBusterEventSchema.safeParse({ ...rest, type: "message" });
    expect(result.success).toBe(true);
  });

  it("accepts every valid exemplarRole value", () => {
    const roles = ["first", "last", "slowest", "one-per-release", "one-novel-stack"] as const;
    for (const role of roles) {
      const result = BugBusterEventSchema.safeParse({
        ...validExceptionEvent(),
        exemplarRole: role,
      });
      expect(result.success, `role "${role}" should be valid`).toBe(true);
    }
  });

  it("round-trips through parse without losing the fingerprint linkage", () => {
    const parsed = BugBusterEventSchema.parse(validExceptionEvent());
    expect(parsed.fingerprint).toBe("fp_a1b2c3");
  });
});
