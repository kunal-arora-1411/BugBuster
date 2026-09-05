import { describe, expect, it } from "vitest";
import { OrgRecordSchema, ResolvedOrgSchema } from "../../src/org.js";

describe("OrgRecordSchema", () => {
  it("accepts a valid control-database org record", () => {
    const result = OrgRecordSchema.safeParse({
      orgId: "org_acme",
      name: "Acme Corp",
      dbName: "bugbuster_org_acme",
      apiKeyHash: "sha256:deadbeef",
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });
});

describe("ResolvedOrgSchema", () => {
  it("accepts a valid resolved-org context, and carries no key material", () => {
    const parsed = ResolvedOrgSchema.parse({ orgId: "org_acme", dbName: "bugbuster_org_acme" });
    expect(Object.keys(parsed).sort()).toEqual(["dbName", "orgId"]);
  });
});
