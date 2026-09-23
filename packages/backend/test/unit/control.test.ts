import { describe, expect, it, vi } from "vitest";
import { retryWithBackoff } from "../../src/db/control.js";

describe("retryWithBackoff", () => {
  it("returns immediately on first success, without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await retryWithBackoff(fn, { delayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries after a transient failure and succeeds on a later attempt", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient TLS blip"))
      .mockResolvedValueOnce("ok");
    const result = await retryWithBackoff(fn, { attempts: 3, delayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws the last error once every attempt is exhausted", async () => {
    const err = new Error("persistent failure");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(retryWithBackoff(fn, { attempts: 3, delayMs: 1 })).rejects.toThrow(
      "persistent failure",
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
