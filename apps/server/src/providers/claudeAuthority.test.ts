import { describe, expect, it } from "vitest";

import { claudeAuthorityInputDigest } from "./claudeAuthority";

describe("Claude authority input digest", () => {
  it("fails closed before traversing beyond the cumulative input budget", () => {
    const input: Record<string, unknown> = {
      a: "x".repeat(1_048_577),
    };
    Object.defineProperty(input, "z", {
      enumerable: true,
      get: () => {
        throw new Error("unbounded traversal reached later provider input");
      },
    });

    expect(() => claudeAuthorityInputDigest(input)).not.toThrow();
    expect(claudeAuthorityInputDigest(input)).toBeUndefined();
  });

  it("rejects excessive depth, cycles, and container breadth", () => {
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let depth = 0; depth < 18; depth += 1) {
      const child: Record<string, unknown> = {};
      deep.next = child;
      deep = child;
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const broad = Array.from({ length: 4_097 }, () => null);

    expect(claudeAuthorityInputDigest(root)).toBeUndefined();
    expect(claudeAuthorityInputDigest(cyclic)).toBeUndefined();
    expect(claudeAuthorityInputDigest(broad)).toBeUndefined();
  });

  it("is stable across object key order without retaining the canonical input", () => {
    const first = claudeAuthorityInputDigest({ b: [true, 2], a: "value" });
    const repeated = claudeAuthorityInputDigest({ a: "value", b: [true, 2] });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(repeated).toBe(first);
    expect(first).not.toContain("value");
  });
});
