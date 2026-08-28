import { describe, expect, it } from "vitest";
import {
  lineageParentTitle,
  threadAncestorChain,
  threadDirectDescendants,
  threadHasLineage,
  type LineageThread,
} from "./threadLineage";

const origin: LineageThread = { threadId: "origin", title: "Original direction" };
const branch: LineageThread = {
  threadId: "branch",
  title: "Second direction",
  lineageParentThreadId: "origin",
};
const grandchild: LineageThread = {
  threadId: "grandchild",
  title: "Third direction",
  lineageParentThreadId: "branch",
};
const sibling: LineageThread = {
  threadId: "sibling",
  title: "Another try",
  lineageParentThreadId: "origin",
};
const lone: LineageThread = { threadId: "lone", title: "Never forked" };

const threads: ReadonlyArray<LineageThread> = [origin, branch, grandchild, sibling, lone];

describe("threadAncestorChain", () => {
  it("walks origin then ancestors in chain order", () => {
    expect(threadAncestorChain("grandchild", threads)).toEqual([
      { kind: "thread", threadId: "origin", title: "Original direction" },
      { kind: "thread", threadId: "branch", title: "Second direction" },
    ]);
  });

  it("names a parent that is not in the visible list as an unavailable origin", () => {
    expect(
      threadAncestorChain("orphan", [
        { threadId: "orphan", title: "Restored", lineageParentThreadId: "archived" },
        origin,
      ]),
    ).toEqual([{ kind: "origin-unavailable" }]);
  });

  it("keeps visible ancestors and still names a missing origin", () => {
    expect(
      threadAncestorChain("grandchild", [
        branch,
        grandchild,
        { threadId: "other", title: "Unrelated" },
      ]),
    ).toEqual([
      { kind: "origin-unavailable" },
      { kind: "thread", threadId: "branch", title: "Second direction" },
    ]);
  });

  it("stops a cyclic parent chain instead of walking forever", () => {
    const cyclic: ReadonlyArray<LineageThread> = [
      { threadId: "a", title: "A", lineageParentThreadId: "b" },
      { threadId: "b", title: "B", lineageParentThreadId: "a" },
    ];

    expect(threadAncestorChain("a", cyclic)).toEqual([
      { kind: "thread", threadId: "b", title: "B" },
    ]);
    expect(threadAncestorChain("b", cyclic)).toEqual([
      { kind: "thread", threadId: "a", title: "A" },
    ]);
  });

  it("returns no ancestors for a thread the list does not hold", () => {
    expect(threadAncestorChain("missing", threads)).toEqual([]);
  });
});

describe("threadDirectDescendants", () => {
  it("lists only direct forks, not grandchildren, ordered by title", () => {
    expect(threadDirectDescendants("origin", threads)).toEqual([
      { threadId: "sibling", title: "Another try" },
      { threadId: "branch", title: "Second direction" },
    ]);
    expect(threadDirectDescendants("branch", threads)).toEqual([
      { threadId: "grandchild", title: "Third direction" },
    ]);
    expect(threadDirectDescendants("grandchild", threads)).toEqual([]);
  });
});

describe("threadHasLineage", () => {
  it("marks a fork, a fork source, and a thread whose origin is gone, and skips an unrelated thread", () => {
    expect(threadHasLineage(branch, threads)).toBe(true);
    expect(threadHasLineage(origin, threads)).toBe(true);
    expect(
      threadHasLineage(
        { threadId: "orphan", title: "Restored", lineageParentThreadId: "archived" },
        threads,
      ),
    ).toBe(true);
    expect(threadHasLineage(lone, threads)).toBe(false);
  });
});

describe("lineageParentTitle", () => {
  it("resolves a visible parent title and omits one that is no longer in the list", () => {
    expect(lineageParentTitle(branch, threads)).toBe("Original direction");
    expect(
      lineageParentTitle(
        { threadId: "orphan", title: "Restored", lineageParentThreadId: "archived" },
        threads,
      ),
    ).toBeUndefined();
    expect(lineageParentTitle(origin, threads)).toBeUndefined();
  });
});
