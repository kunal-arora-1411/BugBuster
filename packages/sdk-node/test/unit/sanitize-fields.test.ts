import { describe, expect, it } from "vitest";
import { MAX_LOG_FIELDS_BYTES } from "@bugbusterhq/types";
import { REDACTED_VALUE, sanitizeFields } from "../../src/worker/sanitize-fields.js";

describe("sanitizeFields", () => {
  it("returns undefined for undefined or empty input", () => {
    expect(sanitizeFields(undefined)).toBeUndefined();
    expect(sanitizeFields({})).toBeUndefined();
  });

  it("passes plain JSON-safe values through unchanged", () => {
    const input = { orderId: "o_1", items: 3, paid: true, tags: ["a", "b"], nested: { ok: null } };
    expect(sanitizeFields(input)).toEqual(input);
  });

  it("redacts by key name, at any depth, whatever the value's type", () => {
    const out = sanitizeFields({
      password: "hunter2",
      user: { Authorization: "Bearer abc", apiKey: "k", name: "ok" },
      sessionToken: 12345,
      "x-api-key": "k2",
    });
    expect(out).toEqual({
      password: REDACTED_VALUE,
      user: { Authorization: REDACTED_VALUE, apiKey: REDACTED_VALUE, name: "ok" },
      sessionToken: REDACTED_VALUE,
      "x-api-key": REDACTED_VALUE,
    });
  });

  it("matches key segments, not substrings: common keys that merely contain a word are kept", () => {
    const input = {
      className: "btn",
      passengers: 3,
      compass: "N",
      bypassCache: true,
      maxTokens: 512,
      tokenizer: "bpe",
      keyboard: "us",
    };
    expect(sanitizeFields(input)).toEqual(input);
  });

  it("still redacts each casing style of a sensitive key", () => {
    const out = sanitizeFields({
      APIKey: "a",
      api_key: "b",
      "set-cookie": "c",
      client_secret: "d",
      refreshToken: "e",
      privateKey: "f",
      SSN: "g",
      dbpassword: "h",
      pass: "i",
    });
    expect(Object.values(out ?? {}).every((v) => v === REDACTED_VALUE)).toBe(true);
  });

  it("redacts sensitive patterns inside string values (emails, bearer tokens)", () => {
    const out = sanitizeFields({ note: "contact bob@example.com", hdr: "Bearer abc.def.ghi" });
    expect(out?.note).toBe("contact [redacted-email]");
    expect(out?.hdr).toBe("[redacted-token]");
  });

  it("survives circular references without throwing", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    const out = sanitizeFields({ a });
    expect(out).toEqual({ a: { name: "a", self: "[Circular]" } });
  });

  it("does not mistake a shared (non-circular) reference for a cycle", () => {
    const shared = { x: 1 };
    expect(sanitizeFields({ one: shared, two: shared })).toEqual({
      one: { x: 1 },
      two: { x: 1 },
    });
  });

  it("converts bigint, Date, Error, Set, Map, and drops functions/symbols/undefined", () => {
    const out = sanitizeFields({
      big: 10n,
      when: new Date("2026-01-02T03:04:05.000Z"),
      err: new Error("nope"),
      set: new Set([1, 2]),
      map: new Map([["k", "v"]]),
      fn: () => 1,
      sym: Symbol("s"),
      missing: undefined,
      nan: NaN,
    });
    expect(out?.big).toBe("10");
    expect(out?.when).toBe("2026-01-02T03:04:05.000Z");
    expect((out?.err as { name: string; message: string }).message).toBe("nope");
    expect(out?.set).toEqual([1, 2]);
    expect(out?.map).toEqual({ k: "v" });
    expect(out).not.toHaveProperty("fn");
    expect(out).not.toHaveProperty("sym");
    expect(out).not.toHaveProperty("missing");
    expect(out?.nan).toBe("NaN");
  });

  it("makes keys MongoDB-safe: dots replaced, leading $ replaced", () => {
    const out = sanitizeFields({ "a.b": 1, $set: 2, ok: 3 });
    expect(out).toEqual({ a_b: 1, _set: 2, ok: 3 });
  });

  it("caps depth, array length, and string length", () => {
    const deep = { l1: { l2: { l3: { l4: { l5: "too deep" } } } } };
    expect(JSON.stringify(sanitizeFields(deep))).toContain("[Object]");

    const out = sanitizeFields({
      list: Array.from({ length: 80 }, (_, i) => i),
      long: "x".repeat(5000),
    });
    expect((out?.list as unknown[]).length).toBe(51); // 50 items + a "+30 more" marker
    expect((out?.long as string).length).toBeLessThan(1100);
  });

  it("never throws on a hostile object with a throwing getter", () => {
    const hostile = {
      get boom(): string {
        throw new Error("getter exploded");
      },
      fine: 1,
    };
    expect(() => sanitizeFields(hostile)).not.toThrow();
    expect(sanitizeFields(hostile)?.fine).toBe(1);
  });

  it("replaces an over-budget result with an explicit truncation marker, not clipped JSON", () => {
    const fields: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) fields[`key${i}`] = "y".repeat(1000);
    const out = sanitizeFields(fields);
    expect(out?._truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThan(MAX_LOG_FIELDS_BYTES);
  });
});
