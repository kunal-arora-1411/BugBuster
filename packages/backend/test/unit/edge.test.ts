import { describe, expect, it } from "vitest";
import { extractBearerToken } from "../../src/ingest/edge.js";

describe("extractBearerToken", () => {
  it("extracts a valid bearer token", () => {
    expect(extractBearerToken("Bearer sk_test_123")).toBe("sk_test_123");
  });

  it("returns undefined when the header is missing", () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
  });

  it("returns undefined for a non-Bearer scheme", () => {
    expect(extractBearerToken("Basic dXNlcjpwYXNz")).toBeUndefined();
  });
});
