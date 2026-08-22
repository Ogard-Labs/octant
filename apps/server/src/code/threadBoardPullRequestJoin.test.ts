import { decodeProjectId, UtcTimestamp } from "@octant/contracts";
import { decodeCodeThreadId } from "@octant/contracts/code";
import { decodeWorkArtifactRef } from "@octant/contracts/work-artifacts";
import {
  decodeWorkPromotionFrame,
  decodeWorkPromotionProposalId,
} from "@octant/contracts/work-promotion";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { WorkPromotionProjection } from "../work/workPromotionProjection";
import {
  joinCodeThreadBoardPullRequests,
  joinWorkThreadBoardPullRequests,
} from "./threadBoardPullRequestJoin";

const projectId = decodeProjectId("10000000-0000-4000-8000-000000000001");
const targetProjectId = decodeProjectId("10000000-0000-4000-8000-000000000099");
const codeThreadId = decodeCodeThreadId("20000000-0000-4000-8000-000000000001");
const promotedThreadId = decodeCodeThreadId("20000000-0000-4000-8000-000000000002");
const linkedThreadId = decodeCodeThreadId("20000000-0000-4000-8000-000000000003");
const proposalId = decodeWorkPromotionProposalId("30000000-0000-4000-8000-000000000001");
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

  it("joins Work board pull requests only through promoted or linked Code threads", () => {
    const projection = new WorkPromotionProjection();
    projection.apply(
      decodeWorkPromotionFrame({
        kind: "approved",
        proposal: {
          proposalId,
          originProjectId: projectId,
          targetCodeProjectId: targetProjectId,
          selectedContext: {
            summary: "Promoted work",
            artifactRefs: [decodeWorkArtifactRef("artifact-a")],
          },
          status: "approved",
          proposedCodeExecutionPolicy: "approval-gated",
          proposedCodePermissionPersistence: "current-session",
          proposedBy: {
            kind: "local-user",
            actorId: "55555555-5555-4555-8555-555555555555",
          },
          proposedAt: decodeTimestamp("2026-08-22T08:00:00.000Z"),
          decidedAt: decodeTimestamp("2026-08-22T08:01:00.000Z"),
          linkedCodeThreadId: promotedThreadId,
          version: 2,
        },
        linkedCodeThreadId: promotedThreadId,
      }),
    );

    const summaries = joinWorkThreadBoardPullRequests({
      workProjectId: projectId,
      promotions: projection.snapshot(),
      codeThreads: [
        { id: promotedThreadId, projectId: targetProjectId },
        { id: linkedThreadId, projectId: targetProjectId },
      ],
      snapshot: {
        rows: [
          {
            projectId: targetProjectId,
            projectName: "Target Code Project",
            repositoryOwner: "octant",
            repositoryName: "octant",
            number: 12,
            title: "Promoted pull request",
            draft: false,
            author: "octocat",
            baseBranch: "main",
            headBranch: "feature/promoted",
            updatedAt: "2026-08-22T08:00:00Z",
            checks: "passing",
            review: "approved",
            linkedThreads: [{ threadId: promotedThreadId, title: "Promoted thread" }],
          },
          {
            projectId: targetProjectId,
            projectName: "Target Code Project",
            repositoryOwner: "octant",
            repositoryName: "octant",
            number: 13,
            title: "Linked pull request",
            draft: false,
            author: "octocat",
            baseBranch: "main",
            headBranch: "feature/linked",
            updatedAt: "2026-08-22T07:00:00Z",
            checks: "pending",
            review: "none",
            linkedThreads: [{ threadId: linkedThreadId, title: "Linked thread" }],
          },
        ],
        freshness: {
          status: "fresh",
          lastSuccessfulRefreshAt: decodeTimestamp("2026-08-22T08:00:00.000Z"),
        },
        githubRevoked: false,
      },
    });

    expect(summaries.items.map((item) => item.relationship)).toEqual(["promoted", "linked"]);
    expect(summaries.items[0]?.readyToMerge).toBe(true);
    expect(summaries.items[1]?.readyToMerge).toBe(false);
  });
});
