import { decodeProjectId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  decodeThreadBoardPullRequestSummaries,
  MAX_THREAD_BOARD_PULL_REQUEST_DISPLAY,
} from "./threadBoardPullRequests";

const projectId = decodeProjectId("10000000-0000-4000-8000-000000000001");

describe("thread board pull-request contracts", () => {
  it("documents the card display bound", () => {
    expect(MAX_THREAD_BOARD_PULL_REQUEST_DISPLAY).toBe(3);
  });

  it("decodes bounded pull-request summaries with overflow", () => {
    const decoded = decodeThreadBoardPullRequestSummaries({
      items: [
        {
          identity: {
            projectId,
            repositoryOwner: "octant",
            repositoryName: "octant",
            number: 12,
          },
          title: "Board pull request",
          state: "open",
          checks: "passing",
          review: "approved",
          mergeability: "mergeable",
          freshness: "fresh",
          readyToMerge: true,
        },
      ],
      hiddenCount: 2,
    });
    expect(decoded.hiddenCount).toBe(2);
    expect(decoded.items[0]?.readyToMerge).toBe(true);
  });

  it("decodes a summary with line counts, check counts and merging, and one without", () => {
    const base = {
      identity: { projectId, repositoryOwner: "octant", repositoryName: "octant", number: 12 },
      title: "Board pull request",
      state: "open",
      checks: "pending",
      review: "none",
      mergeability: "mergeable",
      freshness: "fresh",
      readyToMerge: false,
    };
    const decoded = decodeThreadBoardPullRequestSummaries({
      items: [
        {
          ...base,
          additions: 10,
          deletions: 2,
          checkCounts: { passed: 1, total: 3 },
          merging: "auto-merge",
        },
        base,
      ],
      hiddenCount: 0,
    });
    expect(decoded.items[0]).toMatchObject({ additions: 10, merging: "auto-merge" });
    expect(decoded.items[1]?.checkCounts).toBe(undefined);
    expect(() =>
      decodeThreadBoardPullRequestSummaries({
        items: [{ ...base, checkCounts: { passed: 4, total: 3 } }],
        hiddenCount: 0,
      }),
    ).toThrow();
    const stacked = (stack: unknown) =>
      decodeThreadBoardPullRequestSummaries({ items: [{ ...base, stack }], hiddenCount: 0 });
    expect(stacked({ position: 2, size: 4, parent: 11 }).items[0]?.stack?.parent).toBe(11);
    expect(stacked({ position: 1, size: 4 }).items[0]?.stack?.parent).toBe(undefined);
    // A layer above the bottom names the one below it, and no place is past the top.
    expect(() => stacked({ position: 2, size: 4 })).toThrow();
    expect(() => stacked({ position: 1, size: 4, parent: 11 })).toThrow();
    expect(() => stacked({ position: 5, size: 4, parent: 11 })).toThrow();
    expect(() =>
      decodeThreadBoardPullRequestSummaries({
        items: [{ ...base, additions: -5 }],
        hiddenCount: 0,
      }),
    ).toThrow();
  });
});
