import {
  decodeCodePullRequestLinkCreated,
  decodeCodeThreadId,
  decodeProjectId,
  decodePullRequestLinkId,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  applyPullRequestLinkEvent,
  buildDuplicatePullRequestSwitchNotices,
  emptyPullRequestLinkRegistryState,
  missingPullRequestForgeIds,
  pullRequestDisplayFieldsChanged,
  reconcileMergedPullRequestSwitches,
  resolveCanonicalPullRequestLink,
  selectSurvivingPullRequestLink,
} from "./pullRequestIdentityPolicy";

const projectId = decodeProjectId("10000000-0000-4000-8000-000000000001");
const linkEarly = decodePullRequestLinkId("50000000-0000-4000-8000-000000000001");
const linkLate = decodePullRequestLinkId("50000000-0000-4000-8000-000000000002");
const threadA = decodeCodeThreadId("20000000-0000-4000-8000-000000000001");
const threadB = decodeCodeThreadId("20000000-0000-4000-8000-000000000002");

describe("pull request identity policy", () => {
  it("folds creation, backfill, rename display update, and duplicate merge without deleting history", () => {
    let state = emptyPullRequestLinkRegistryState();
    state = applyPullRequestLinkEvent(
      state,
      {
        kind: "created",
        payload: decodeCodePullRequestLinkCreated({
          linkId: linkEarly,
          projectId,
          threadIds: [threadA],
          host: "github.com",
          repositoryOwner: "old-org",
          repositoryName: "old-repo",
          number: 42,
          linkedAt: "2026-11-01T10:00:00.000Z",
        }),
      },
      1,
    );
    state = applyPullRequestLinkEvent(
      state,
      {
        kind: "created",
        payload: decodeCodePullRequestLinkCreated({
          linkId: linkLate,
          projectId,
          threadIds: [threadB],
          host: "github.com",
          repositoryOwner: "new-org",
          repositoryName: "new-repo",
          number: 42,
          linkedAt: "2026-11-02T10:00:00.000Z",
        }),
      },
      2,
    );

    const early = state.byId.get(String(linkEarly));
    const late = state.byId.get(String(linkLate));
    expect(early).toBeDefined();
    expect(late).toBeDefined();
    if (early === undefined || late === undefined) throw new Error("expected both links");

    expect(selectSurvivingPullRequestLink([late, early])).toEqual({
      survivor: early,
      duplicates: [late],
    });

    state = applyPullRequestLinkEvent(
      state,
      {
        kind: "forge-ids-backfilled",
        payload: {
          linkId: linkEarly,
          pullRequestNodeId: "PR_kwDO42",
          baseRepositoryNodeId: "R_kgDO1",
        },
      },
      3,
    );
    state = applyPullRequestLinkEvent(
      state,
      {
        kind: "merged-into",
        payload: {
          linkId: linkLate,
          survivingLinkId: linkEarly,
          pullRequestNodeId: "PR_kwDO42",
          baseRepositoryNodeId: "R_kgDO1",
          movedThreadIds: [threadB],
          disabledSwitches: ["auto-fix"],
        },
      },
      4,
    );
    state = applyPullRequestLinkEvent(
      state,
      {
        kind: "display-updated",
        payload: {
          linkId: linkEarly,
          repositoryOwner: "new-org",
          repositoryName: "new-repo",
          number: 42,
          url: "https://github.com/new-org/new-repo/pull/42",
        },
      },
      5,
    );

    const survivor = state.byId.get(String(linkEarly));
    const merged = state.byId.get(String(linkLate));
    expect(survivor).toMatchObject({
      status: "active",
      repositoryOwner: "new-org",
      repositoryName: "new-repo",
      pullRequestNodeId: "PR_kwDO42",
      baseRepositoryNodeId: "R_kgDO1",
      threadIds: [threadA, threadB],
    });
    expect(merged).toMatchObject({
      status: "merged-into",
      mergedIntoLinkId: linkEarly,
    });
    expect(resolveCanonicalPullRequestLink(state, linkLate)?.linkId).toBe(linkEarly);
    if (survivor !== undefined) {
      expect(
        missingPullRequestForgeIds(survivor, {
          pullRequestNodeId: "PR_kwDO42",
          baseRepositoryNodeId: "R_kgDO1",
        }),
      ).toBeUndefined();
      expect(
        pullRequestDisplayFieldsChanged(survivor, {
          repositoryOwner: "new-org",
          repositoryName: "new-repo",
          number: 42,
        }),
      ).toBe(false);
    }
  });

  it("keeps switches on only when on in both duplicate links and builds thread notices for mixed switches", () => {
    const surviving = {
      mergeWhenReadyOn: true,
      autoFix: { on: true, threadId: String(threadA) },
      watch: { on: false },
    };
    const merged = {
      mergeWhenReadyOn: true,
      autoFix: { on: false },
      watch: { on: true, threadId: String(threadB) },
    };

    const decision = reconcileMergedPullRequestSwitches(surviving, merged);
    expect(decision).toEqual({
      mergeWhenReady: "keep-on",
      autoFix: "turn-off",
      watch: "turn-off",
      disabledSwitches: ["auto-fix", "watch"],
    });

    const notices = buildDuplicatePullRequestSwitchNotices({
      pullRequestNumber: 42,
      decision,
      surviving,
      merged,
      allLinkedThreadIds: [String(threadA), String(threadB)],
    });
    expect(notices).toEqual([
      {
        threadId: String(threadA),
        switches: ["auto-fix"],
        notice:
          "Auto-fix was turned off on pull request #42 because two duplicate links for the same pull request were merged and it was only on in one of them. You can turn it back on.",
      },
      {
        threadId: String(threadB),
        switches: ["watch"],
        notice:
          "Pull request watch was turned off on pull request #42 because two duplicate links for the same pull request were merged and it was only on in one of them. You can turn it back on.",
      },
    ]);
  });

  it("combines multiple turned-off switches for the same thread into one notice", () => {
    const surviving = {
      mergeWhenReadyOn: true,
      autoFix: { on: true, threadId: String(threadA) },
      watch: { on: false },
    };
    const merged = {
      mergeWhenReadyOn: false,
      autoFix: { on: false },
      watch: { on: false },
    };
    const decision = reconcileMergedPullRequestSwitches(surviving, merged);
    expect(decision.disabledSwitches).toEqual(["merge-when-ready", "auto-fix"]);

    const notices = buildDuplicatePullRequestSwitchNotices({
      pullRequestNumber: 19,
      decision,
      surviving,
      merged,
      allLinkedThreadIds: [String(threadA), String(threadB)],
    });
    expect(notices).toEqual([
      {
        threadId: String(threadA),
        switches: ["merge-when-ready", "auto-fix"],
        notice:
          "Merge when ready and Auto-fix were turned off on pull request #19 because two duplicate links for the same pull request were merged and they were only on in one of them. You can turn them back on.",
      },
      {
        threadId: String(threadB),
        switches: ["merge-when-ready"],
        notice:
          "Merge when ready was turned off on pull request #19 because two duplicate links for the same pull request were merged and it was only on in one of them. You can turn it back on.",
      },
    ]);
  });
});
