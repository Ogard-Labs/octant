import {
  decodeCodePullRequestLinkCreated,
  decodeCodeThreadId,
  decodeProjectId,
  decodePullRequestLinkId,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  applyPullRequestLinkEvent,
  areSamePullRequestRepositoryInProject,
  buildDuplicatePullRequestSwitchNotices,
  canonicalPullRequestRepositoryInProject,
  emptyPullRequestLinkRegistryState,
  listPullRequestDisplayAliases,
  missingPullRequestForgeIds,
  pullRequestDisplayFieldsChanged,
  reconcileMergedPullRequestSwitches,
  resolveCanonicalPullRequestLink,
  resolvePullRequestLink,
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

  it("resolves renamed and merged historical display coordinates to the canonical link and refuses conflicting forge node IDs", () => {
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
          repositoryOwner: "acme",
          repositoryName: "old-repo",
          number: 42,
          pullRequestNodeId: "PR_kwDO42",
          baseRepositoryNodeId: "R_kgDO1",
          linkedAt: "2026-11-01T10:00:00.000Z",
        }),
      },
      1,
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
      2,
    );

    expect(
      resolvePullRequestLink(state, {
        projectId,
        repositoryOwner: "acme",
        repositoryName: "old-repo",
        number: 42,
      })?.linkId,
    ).toBe(linkEarly);
    expect(
      resolvePullRequestLink(state, {
        projectId,
        repositoryOwner: "acme",
        repositoryName: "old-repo",
        number: 42,
        pullRequestNodeId: "PR_kwDOother99",
      }),
    ).toBeUndefined();
    expect(
      resolvePullRequestLink(state, {
        projectId,
        repositoryOwner: "acme",
        repositoryName: "old-repo",
        number: 42,
        baseRepositoryNodeId: "R_kgDOdifferent99",
      }),
    ).toBeUndefined();
    expect(
      areSamePullRequestRepositoryInProject(
        state,
        projectId,
        { owner: "acme", name: "old-repo" },
        { owner: "new-org", name: "new-repo" },
      ),
    ).toBe(true);
    expect(
      areSamePullRequestRepositoryInProject(
        state,
        projectId,
        { owner: "acme", name: "old-repo" },
        { owner: "other", name: "unrelated" },
      ),
    ).toBe(false);
    expect(
      canonicalPullRequestRepositoryInProject(state, projectId, {
        owner: "acme",
        name: "old-repo",
      }),
    ).toEqual({
      owner: "new-org",
      name: "new-repo",
      baseRepositoryNodeId: "R_kgDO1",
    });
    expect(listPullRequestDisplayAliases(state, linkEarly)).toHaveLength(2);
  });

  it("never bridges two distinct base repository node IDs through a reused repository name", () => {
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
          repositoryOwner: "acme",
          repositoryName: "reused",
          number: 42,
          pullRequestNodeId: "PR_kwDOold42",
          baseRepositoryNodeId: "R_kgDOoldrepo1",
          linkedAt: "2026-11-01T10:00:00.000Z",
        }),
      },
      1,
    );
    state = applyPullRequestLinkEvent(
      state,
      {
        kind: "display-updated",
        payload: {
          linkId: linkEarly,
          repositoryOwner: "acme",
          repositoryName: "original-renamed",
          number: 42,
          url: "https://github.com/acme/original-renamed/pull/42",
        },
      },
      2,
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
          repositoryOwner: "acme",
          repositoryName: "reused",
          number: 42,
          pullRequestNodeId: "PR_kwDOnew42",
          baseRepositoryNodeId: "R_kgDOnewrepo2",
          linkedAt: "2026-11-02T10:00:00.000Z",
        }),
      },
      3,
    );

    expect(
      areSamePullRequestRepositoryInProject(
        state,
        projectId,
        { owner: "acme", name: "reused" },
        { owner: "acme", name: "original-renamed" },
      ),
    ).toBe(false);
    expect(
      canonicalPullRequestRepositoryInProject(state, projectId, {
        owner: "acme",
        name: "reused",
      }),
    ).toEqual({
      owner: "acme",
      name: "reused",
      baseRepositoryNodeId: "R_kgDOnewrepo2",
    });
    expect(
      canonicalPullRequestRepositoryInProject(state, projectId, {
        owner: "acme",
        name: "original-renamed",
      }),
    ).toEqual({
      owner: "acme",
      name: "original-renamed",
      baseRepositoryNodeId: "R_kgDOoldrepo1",
    });

    // If the newer repository also renames away, the reused historical name is
    // ambiguous between two distinct repository node IDs and must fail closed.
    state = applyPullRequestLinkEvent(
      state,
      {
        kind: "display-updated",
        payload: {
          linkId: linkLate,
          repositoryOwner: "acme",
          repositoryName: "new-renamed",
          number: 42,
          url: "https://github.com/acme/new-renamed/pull/42",
        },
      },
      4,
    );
    expect(
      areSamePullRequestRepositoryInProject(
        state,
        projectId,
        { owner: "acme", name: "reused" },
        { owner: "acme", name: "original-renamed" },
      ),
    ).toBe(false);
    expect(
      areSamePullRequestRepositoryInProject(
        state,
        projectId,
        { owner: "acme", name: "reused" },
        { owner: "acme", name: "new-renamed" },
      ),
    ).toBe(false);
    expect(
      areSamePullRequestRepositoryInProject(
        state,
        projectId,
        { owner: "acme", name: "original-renamed" },
        { owner: "acme", name: "new-renamed" },
      ),
    ).toBe(false);
    expect(
      canonicalPullRequestRepositoryInProject(state, projectId, {
        owner: "acme",
        name: "reused",
      }),
    ).toBeUndefined();
  });

  it("keeps rename equivalence for a partially backfilled link without a repository node ID alongside a fully backfilled link at the new name, while still refusing distinct known repository node IDs", () => {
    const linkThird = decodePullRequestLinkId("50000000-0000-4000-8000-000000000003");
    let state = emptyPullRequestLinkRegistryState();
    // PR #41: has PR node ID and recorded rename acme/old -> acme/new, but
    // baseRepositoryNodeId was unavailable (partial backfill).
    state = applyPullRequestLinkEvent(
      state,
      {
        kind: "created",
        payload: decodeCodePullRequestLinkCreated({
          linkId: linkEarly,
          projectId,
          threadIds: [threadA],
          host: "github.com",
          repositoryOwner: "acme",
          repositoryName: "old",
          number: 41,
          pullRequestNodeId: "PR_kwDO41",
          linkedAt: "2026-11-01T10:00:00.000Z",
        }),
      },
      1,
    );
    state = applyPullRequestLinkEvent(
      state,
      {
        kind: "display-updated",
        payload: {
          linkId: linkEarly,
          repositoryOwner: "acme",
          repositoryName: "new",
          number: 41,
          url: "https://github.com/acme/new/pull/41",
        },
      },
      2,
    );
    // PR #42: later created at acme/new with full forge IDs including R_kgDO123.
    state = applyPullRequestLinkEvent(
      state,
      {
        kind: "created",
        payload: decodeCodePullRequestLinkCreated({
          linkId: linkLate,
          projectId,
          threadIds: [threadB],
          host: "github.com",
          repositoryOwner: "acme",
          repositoryName: "new",
          number: 42,
          pullRequestNodeId: "PR_kwDO42",
          baseRepositoryNodeId: "R_kgDO123",
          linkedAt: "2026-11-02T10:00:00.000Z",
        }),
      },
      3,
    );

    expect(
      areSamePullRequestRepositoryInProject(
        state,
        projectId,
        { owner: "acme", name: "old" },
        { owner: "acme", name: "new" },
      ),
    ).toBe(true);
    expect(
      canonicalPullRequestRepositoryInProject(state, projectId, {
        owner: "acme",
        name: "old",
      }),
    ).toEqual({
      owner: "acme",
      name: "new",
    });
    expect(
      canonicalPullRequestRepositoryInProject(state, projectId, {
        owner: "acme",
        name: "new",
      }),
    ).toEqual({
      owner: "acme",
      name: "new",
      baseRepositoryNodeId: "R_kgDO123",
    });

    // Once a third link proves acme/old is now owned by a distinct known
    // repository node ID (R_kgDO456), acme/old and acme/new must no longer bridge.
    state = applyPullRequestLinkEvent(
      state,
      {
        kind: "created",
        payload: decodeCodePullRequestLinkCreated({
          linkId: linkThird,
          projectId,
          threadIds: [],
          host: "github.com",
          repositoryOwner: "acme",
          repositoryName: "old",
          number: 43,
          pullRequestNodeId: "PR_kwDO43",
          baseRepositoryNodeId: "R_kgDO456",
          linkedAt: "2026-11-03T10:00:00.000Z",
        }),
      },
      4,
    );
    expect(
      areSamePullRequestRepositoryInProject(
        state,
        projectId,
        { owner: "acme", name: "old" },
        { owner: "acme", name: "new" },
      ),
    ).toBe(false);
  });
});
