import { describe, expect, it } from "vitest";
import { trimTrailingSlashes, trimTrailingUrlPunctuation } from "./trimTrailing";

describe("trailing trims", () => {
  it("removes every trailing slash and keeps inner ones", () => {
    expect(trimTrailingSlashes("/a/b///")).toBe("/a/b");
    expect(trimTrailingSlashes("///")).toBe("");
    expect(trimTrailingSlashes("a")).toBe("a");
  });

  it("finishes quickly on a very long run of slashes", () => {
    const started = Date.now();
    expect(trimTrailingSlashes(`x${"/".repeat(200_000)}`)).toBe("x");
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("removes trailing URL punctuation and keeps the rest", () => {
    expect(trimTrailingUrlPunctuation("https://a.test/x).,;")).toBe("https://a.test/x");
    expect(trimTrailingUrlPunctuation("https://a.test/(x)y")).toBe("https://a.test/(x)y");
    expect(trimTrailingUrlPunctuation(")".repeat(200_000))).toBe("");
  });
});
