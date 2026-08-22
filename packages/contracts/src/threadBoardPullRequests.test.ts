import { describe, expect, it } from "vitest";
import {
  decodeThreadBoardPullRequestSummaries,
  MAX_THREAD_BOARD_PULL_REQUEST_DISPLAY,
  ThreadBoardPullRequestSummaries,
} from "./threadBoardPullRequests";

describe("thread board pull-request contracts", () => {
  it("documents the card display bound", () => {
    expect(MAX_THREAD_BOARD_PULL_REQUEST_DISPLAY).toBe(3);
  });

  it("decodes bounded pull-request summaries with overflow", () => {
    const decoded = decodeThreadBoardPullRequestSummaries({
      items: [
        {
          identity: {
            projectId: "10000000-0000-4000-8000-000000000001",
            repositoryOwner: "octant",
            repositoryName: "octant",
            number: 12,
          },
          title: "Board pull request",
          state: "open",
          checks: "passing",
          review: "approved",
          freshness: "fresh",
          readyToMerge: true,
        },
      ],
      hiddenCount: 2,
    } satisfies ThreadBoardPullRequestSummaries);
    expect(decoded.hiddenCount).toBe(2);
    expect(decoded.items[0]?.readyToMerge).toBe(true);
  });
});
