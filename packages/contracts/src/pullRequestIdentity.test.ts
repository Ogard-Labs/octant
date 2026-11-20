import { describe, expect, it } from "vitest";
import {
  decodeCodeOperationResult,
  decodeCodePullRequestLinkCreated,
  decodeCodePullRequestLinkDisplayUpdated,
  decodeCodePullRequestLinkForgeIdsBackfilled,
  decodeCodePullRequestLinkMergedInto,
  decodeCodeThreadId,
  decodeProjectId,
  decodePullRequestLinkId,
} from "./index";

const linkA = decodePullRequestLinkId("50000000-0000-4000-8000-000000000001");
const linkB = decodePullRequestLinkId("50000000-0000-4000-8000-000000000002");
const projectId = decodeProjectId("10000000-0000-4000-8000-000000000001");
const threadId = decodeCodeThreadId("20000000-0000-4000-8000-000000000001");

describe("pull request identity contracts", () => {
  it("accepts a pull request link created with or without forge node IDs", () => {
    const withForgeIds = decodeCodePullRequestLinkCreated({
      linkId: linkA,
      projectId,
      threadIds: [threadId],
      host: "github.com",
      repositoryOwner: "octant",
      repositoryName: "octant",
      number: 42,
      url: "https://github.com/octant/octant/pull/42",
      baseBranch: "main",
      headOwner: "fork-user",
      headBranch: "feature/work",
      pullRequestNodeId: "PR_kwDOAbc123",
      baseRepositoryNodeId: "R_kgDOXyz789",
      linkedAt: "2026-11-19T12:00:00.000Z",
    });
    expect(withForgeIds.pullRequestNodeId).toBe("PR_kwDOAbc123");
    expect(withForgeIds.baseRepositoryNodeId).toBe("R_kgDOXyz789");

    const withoutForgeIds = decodeCodePullRequestLinkCreated({
      linkId: linkB,
      projectId,
      threadIds: [],
      host: "github.com",
      repositoryOwner: "octant",
      repositoryName: "octant",
      number: 42,
      linkedAt: "2026-11-19T12:00:00.000Z",
    });
    expect(withoutForgeIds.pullRequestNodeId).toBeUndefined();
    expect(withoutForgeIds.baseRepositoryNodeId).toBeUndefined();
  });

  it("refuses a backfill event that carries neither PR nor base repository node ID", () => {
    expect(() =>
      decodeCodePullRequestLinkForgeIdsBackfilled({
        linkId: linkA,
      }),
    ).toThrow();
  });

  it("refuses a merged-into event that names the same link as survivor", () => {
    expect(() =>
      decodeCodePullRequestLinkMergedInto({
        linkId: linkA,
        survivingLinkId: linkA,
        pullRequestNodeId: "PR_kwDOAbc123",
        movedThreadIds: [],
        disabledSwitches: [],
      }),
    ).toThrow();
  });

  it("decodes display updates and merged-into records cleanly", () => {
    const updated = decodeCodePullRequestLinkDisplayUpdated({
      linkId: linkA,
      repositoryOwner: "new-org",
      repositoryName: "new-repo",
      number: 42,
      url: "https://github.com/new-org/new-repo/pull/42",
    });
    expect(updated.repositoryOwner).toBe("new-org");

    const merged = decodeCodePullRequestLinkMergedInto({
      linkId: linkB,
      survivingLinkId: linkA,
      pullRequestNodeId: "PR_kwDOAbc123",
      baseRepositoryNodeId: "R_kgDOXyz789",
      movedThreadIds: [threadId],
      disabledSwitches: ["auto-fix", "watch"],
    });
    expect(merged.disabledSwitches).toEqual(["auto-fix", "watch"]);
  });

  it("keeps pull-request operation results backwards compatible without forge IDs and accepts them when present", () => {
    const legacy = decodeCodeOperationResult({
      kind: "pull-request-state",
      operationId: "30000000-0000-4000-8000-000000000001",
      state: "created",
      number: 175,
      url: "https://github.com/octant/octant/pull/175",
      headRepository: "octocat",
      headBranch: "feature/test",
      baseRepository: "octant/octant",
      baseBranch: "main",
    });
    expect(legacy.kind).toBe("pull-request-state");

    const withIds = decodeCodeOperationResult({
      kind: "pull-request-state",
      operationId: "30000000-0000-4000-8000-000000000002",
      state: "created",
      number: 175,
      url: "https://github.com/octant/octant/pull/175",
      headRepository: "octocat",
      headBranch: "feature/test",
      baseRepository: "octant/octant",
      baseBranch: "main",
      pullRequestNodeId: "PR_kwDOAbc123",
      baseRepositoryNodeId: "R_kgDOXyz789",
    });
    expect(withIds).toMatchObject({
      pullRequestNodeId: "PR_kwDOAbc123",
      baseRepositoryNodeId: "R_kgDOXyz789",
    });
  });
});
