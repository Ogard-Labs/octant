import { describe, expect, it } from "vitest";
import { canonicalRateLimitWindowId, rateLimitWindowId } from "./rateLimitWindowIdentity";

describe("rate-limit window identities", () => {
  it("uses the same scoped identity for a poll and runtime event", () => {
    expect(rateLimitWindowId("codex", "primary", 300)).toBe("codex:primary_5h");
    expect(canonicalRateLimitWindowId(" codex:primary_5h ")).toBe("codex:primary_5h");
  });

  it("keeps long scopes distinct inside the bounded identifier", () => {
    const first = rateLimitWindowId(`${"a".repeat(80)}-one`, "primary", 300);
    const second = rateLimitWindowId(`${"a".repeat(80)}-two`, "primary", 300);
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(64);
    expect(second.length).toBeLessThanOrEqual(64);
  });
});
