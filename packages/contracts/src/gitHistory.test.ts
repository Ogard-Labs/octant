import { describe, expect, it } from "vitest";
import { decodeGitHistoryQuery, decodeGitHistoryResult } from "./gitHistory";

const scope = {
  threadId: "11111111-1111-4111-8111-111111111111",
  checkoutId: "22222222-2222-4222-8222-222222222222",
};

describe("Git history reads", () => {
  it("accepts a bounded history page anchored to immutable commits", () => {
    const query = {
      kind: "history",
      ...scope,
      search: "fix",
      cursor: { tips: ["a".repeat(40)], offset: 100 },
    };
    expect(decodeGitHistoryQuery(query)).toEqual(query);
  });

  it("accepts a local branch name containing Unicode", () => {
    expect(
      decodeGitHistoryQuery({ kind: "history", ...scope, revision: "refs/heads/forbedring/æøå" }),
    ).toMatchObject({ revision: "refs/heads/forbedring/æøå" });
  });

  it("refuses shell options, host paths, and oversized pages at the boundary", () => {
    for (const extra of [
      { revision: "--all" },
      { root: "/private/repo" },
      { revision: "../../outside" },
      { cursor: { tips: [], offset: -1 } },
    ]) {
      expect(() => decodeGitHistoryQuery({ kind: "history", ...scope, ...extra })).toThrow();
    }
    expect(() =>
      decodeGitHistoryQuery({ kind: "commit", ...scope, oid: "HEAD", parent: 0 }),
    ).toThrow();
  });

  it("preserves unavailable and truncated results instead of inventing empty history", () => {
    expect(
      decodeGitHistoryResult({ status: "unavailable", message: "Git history is unavailable." })
        .status,
    ).toBe("unavailable");
    expect(() => decodeGitHistoryResult({ status: "history", commits: [] })).toThrow();
  });
});
