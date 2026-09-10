import { describe, expect, it } from "vitest";
import { layoutCommitGraph } from "./commitGraph";

describe("commit graph", () => {
  it("draws both sides of a merge and joins their common ancestor", () => {
    const rows = layoutCommitGraph([
      { oid: "merge", parents: ["main", "topic"] },
      { oid: "main", parents: ["base"] },
      { oid: "topic", parents: ["base"] },
      { oid: "base", parents: [] },
    ]);
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 1, 0]);
    expect(rows[0]?.edges).toContainEqual({ fromLane: 0, toLane: 1, from: 0.5, to: 1 });
    expect(rows[2]?.edges).toContainEqual({ fromLane: 1, toLane: 0, from: 0.5, to: 1 });
  });
  it("keeps earlier graph rows stable when an older page arrives", () => {
    const first = [
      { oid: "merge", parents: ["a", "b"] },
      { oid: "a", parents: ["base"] },
    ];
    expect(
      layoutCommitGraph([
        ...first,
        { oid: "b", parents: ["base"] },
        { oid: "base", parents: [] },
      ]).slice(0, 2),
    ).toEqual(layoutCommitGraph(first));
  });
});
