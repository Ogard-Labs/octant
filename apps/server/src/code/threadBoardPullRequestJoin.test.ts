import { decodeProjectId, UtcTimestamp } from "@octant/contracts";
import { decodeCodeThreadId } from "@octant/contracts/code";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  joinCodeThreadBoardPullRequests,
  joinWorkThreadBoardPullRequests,
} from "./threadBoardPullRequestJoin";

const projectId = decodeProjectId("10000000-0000-4000-8000-000000000001");
const codeThreadId = decodeCodeThreadId("20000000-0000-4000-8000-000000000001");
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

describe("thread board pull-request join", () => {
  it("joins cached project pull requests onto Code board cards without GitHub calls", () => {
    const summaries = joinCodeThreadBoardPullRequests({
      threadId: codeThreadId,
      snapshot: {
        rows: [
          {
            projectId,
            projectName: "Code Project",
            repositoryOwner: "octant",
            repositoryName: "octant",
            number: 12,
            title: "Board pull request",
            draft: false,
            state: "open",
            mergeability: "mergeable",
            author: "octocat",
            baseBranch: "main",
            headBranch: "feature/board",
            updatedAt: "2026-08-22T08:00:00Z",
            checks: "passing",
            review: "approved",
            linkedThreads: [{ threadId: codeThreadId, title: "Linked thread" }],
          },
        ],
        freshness: {
          status: "fresh",
          lastSuccessfulRefreshAt: decodeTimestamp("2026-08-22T08:00:00.000Z"),
        },
        githubRevoked: false,
      },
    });

    expect(summaries.items).toHaveLength(1);
    expect(summaries.items[0]?.identity.number).toBe(12);
    expect(summaries.items[0]?.readyToMerge).toBe(true);
  });

  it("suppresses Work board pull requests until an exact Work-thread relationship exists", () => {
    const joinLegacyProjectEvidence = joinWorkThreadBoardPullRequests as (
      input: unknown,
    ) => ReturnType<typeof joinWorkThreadBoardPullRequests>;
    const summaries = joinLegacyProjectEvidence({
      workProjectId: projectId,
      promotions: new Map([
        [
          "proposal",
          {
            proposal: {
              status: "approved",
              originProjectId: projectId,
              targetCodeProjectId: projectId,
            },
            linkedCodeThreadId: codeThreadId,
          },
        ],
      ]),
      codeThreads: [{ id: codeThreadId, projectId }],
      snapshot: {
        rows: [
          {
            projectId,
            projectName: "Code Project",
            repositoryOwner: "octant",
            repositoryName: "octant",
            number: 12,
            title: "Sibling-leaking pull request",
            draft: false,
            state: "open",
            mergeability: "mergeable",
            author: "octocat",
            baseBranch: "main",
            headBranch: "feature/board",
            updatedAt: "2026-08-22T08:00:00Z",
            checks: "passing",
            review: "approved",
            linkedThreads: [{ threadId: codeThreadId, title: "Promoted Code thread" }],
          },
        ],
        freshness: { status: "fresh" },
        githubRevoked: false,
      },
    });

    expect(summaries).toEqual({ items: [], hiddenCount: 0 });
  });
});
