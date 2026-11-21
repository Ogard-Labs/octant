import { decodeCodeCheckoutIdentity, decodeCodeThread } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createCoordinatorThreadDoneEvaluator,
  type CoordinatorThreadDoneEvidencePorts,
} from "./coordinatorDoneWhenEvidence";

const now = "2026-11-21T12:00:00.000Z";
const PROJECT = "40000000-0000-4000-8000-000000000001";
const THREAD = "20000000-0000-4000-8000-000000000010";
const CHECKOUT = "30000000-0000-4000-8000-000000000010";
const REPO = `repo_${"a".repeat(64)}`;

function threadWith(
  outcomeKind: "local-implementation" | "opened-pr" | "merged-pr",
  overrides: Record<string, unknown> = {},
) {
  return decodeCodeThread({
    id: THREAD,
    projectId: PROJECT,
    bindingRevisionId: "70000000-0000-4000-8000-000000000001",
    repositoryId: REPO,
    checkoutId: CHECKOUT,
    title: "Worker task",
    lifecycle: "active",
    providerInstanceId: "60000000-0000-4000-8000-000000000001",
    modelId: "model-a",
    executionPolicy: "auto-accept-edits",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "feature/work",
      remoteName: "origin",
      proposedBaseRepository: "Ogard-Labs/octant",
      proposedBaseBranch: "main",
      outcomeKind,
      confirmedAt: now,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

const checkout = decodeCodeCheckoutIdentity({
  id: CHECKOUT,
  repositoryId: REPO,
  kind: "managed-worktree",
  availability: "available",
  head: { kind: "branch", name: "feature/work", oid: "b".repeat(40) },
  ownershipReceiptId: "50000000-0000-4000-8000-000000000001",
  observedAt: now,
});

function basePorts(
  thread: ReturnType<typeof threadWith>,
  overrides: Partial<CoordinatorThreadDoneEvidencePorts> = {},
): CoordinatorThreadDoneEvidencePorts {
  return {
    readThread: () => thread,
    readCheckout: () => checkout,
    projectExists: () => true,
    resolveCheckoutRoot: async () => "/repo/.octant-worktrees/work",
    git: {
      observe: async () => ({
        status: "ready",
        checkoutRoot: "/repo/.octant-worktrees/work",
        head: { kind: "branch", name: "feature/work", oid: "b".repeat(40) },
        statusEntries: [],
        changedPaths: [],
        insertions: 0,
        deletions: 0,
        stagedSummary: [],
        diff: { text: "", byteLength: 0, truncated: false },
        remotes: [],
        upstream: null,
        worktrees: [],
        stateToken: "tok",
      }),
      compareBranch: async () => ({
        status: "ready",
        head: "b".repeat(40),
        base: "a".repeat(40),
        ahead: 2,
        behind: 0,
        mergeability: "clean",
      }),
    },
    history: { read: () => ({ status: "ok", frames: [] }) },
    pullRequestLinks: {
      listForThread: () => [],
      resolveLink: () => undefined,
      areSameRepository: () => false,
    },
    createSignal: () => new AbortController().signal,
    ...overrides,
  };
}

describe("objective thread Done evaluation for coordinator done-when checks", () => {
  it("recognizes a local-implementation thread as Done once commits exist on a clean worktree and fails closed when dirty or unavailable", async () => {
    const localThread = threadWith("local-implementation");
    const cleanDone = createCoordinatorThreadDoneEvaluator(basePorts(localThread));
    expect(await cleanDone(localThread)).toBe(true);

    // Uncommitted edits keep the local-implementation target unmet.
    const dirty = createCoordinatorThreadDoneEvaluator(
      basePorts(localThread, {
        git: {
          observe: async () => ({
            status: "ready",
            checkoutRoot: "/repo/.octant-worktrees/work",
            head: { kind: "branch", name: "feature/work", oid: "b".repeat(40) },
            statusEntries: [{ path: "a.ts", index: " ", worktree: "M" }],
            changedPaths: ["a.ts"],
            insertions: 1,
            deletions: 0,
            stagedSummary: [],
            diff: { text: "", byteLength: 0, truncated: false },
            remotes: [],
            upstream: null,
            worktrees: [],
            stateToken: "tok",
          }),
          compareBranch: async () => ({
            status: "ready",
            head: "b".repeat(40),
            base: "a".repeat(40),
            ahead: 1,
            behind: 0,
            mergeability: "clean",
          }),
        },
      }),
    );
    expect(await dirty(localThread)).toBe(false);

    // Unavailable Git comparison fails closed.
    const unavailable = createCoordinatorThreadDoneEvaluator(
      basePorts(localThread, {
        git: {
          ...basePorts(localThread).git,
          compareBranch: async () => ({ status: "unavailable" }),
        },
      }),
    );
    expect(await unavailable(localThread)).toBe(false);
  });

  it("recognizes a merged-pr thread as Done from fresh pull request observation and short-circuits manual Done marks", async () => {
    const prThread = threadWith("merged-pr");
    const link = {
      linkId: "80000000-0000-4000-8000-000000000001" as never,
      projectId: prThread.projectId,
      status: "active" as const,
      host: "github.com" as const,
      repositoryOwner: "Ogard-Labs",
      repositoryName: "octant",
      number: 42,
      url: "https://github.com/Ogard-Labs/octant/pull/42",
      headBranch: "feature/work",
      baseBranch: "main",
      threadIds: [prThread.id],
      linkedAt: now,
      createdOrder: 1,
      displayOrder: 1,
      updatedAt: now,
    };
    const observePullRequest = vi.fn(async () => ({
      status: "observed" as const,
      state: "merged" as const,
      headSha: "b".repeat(40),
      headBranch: "feature/work",
      baseBranch: "main",
      autoMergeEnabled: false,
      waitingOn: [],
      failures: [],
      baseRepository: "Ogard-Labs/octant",
    }));
    const evaluator = createCoordinatorThreadDoneEvaluator(
      basePorts(prThread, {
        pullRequestLinks: {
          listForThread: () => [link],
          resolveLink: () => link,
          areSameRepository: () => true,
        },
        observePullRequest,
      }),
    );
    expect(await evaluator(prThread)).toBe(true);
    expect(observePullRequest).toHaveBeenCalledOnce();

    // Manual Done mark short-circuits without touching Git or GitHub.
    const observeGit = vi.fn();
    const manualThread = threadWith("local-implementation", { markedDoneAt: now });
    const manualEvaluator = createCoordinatorThreadDoneEvaluator(
      basePorts(manualThread, {
        git: { observe: observeGit, compareBranch: vi.fn() },
      }),
    );
    expect(await manualEvaluator(manualThread)).toBe(true);
    expect(observeGit).not.toHaveBeenCalled();
  });

  it("checks a replacement pull request when an older closed pull request sits first in the link registry", async () => {
    const prThread = threadWith("merged-pr");
    const closedLink = {
      linkId: "80000000-0000-4000-8000-000000000011" as never,
      projectId: prThread.projectId,
      status: "active" as const,
      host: "github.com" as const,
      repositoryOwner: "Ogard-Labs",
      repositoryName: "octant",
      number: 41,
      url: "https://github.com/Ogard-Labs/octant/pull/41",
      headBranch: "feature/work",
      baseBranch: "main",
      threadIds: [prThread.id],
      linkedAt: "2026-11-21T11:00:00.000Z",
      createdOrder: 1,
      displayOrder: 1,
      updatedAt: "2026-11-21T11:00:00.000Z",
    };
    const mergedLink = {
      ...closedLink,
      linkId: "80000000-0000-4000-8000-000000000012" as never,
      number: 42,
      url: "https://github.com/Ogard-Labs/octant/pull/42",
      linkedAt: "2026-11-21T11:30:00.000Z",
      createdOrder: 2,
      displayOrder: 2,
      updatedAt: "2026-11-21T11:30:00.000Z",
    };
    const observePullRequest = vi.fn(async (req: { readonly number: number }) => ({
      status: "observed" as const,
      state: req.number === 42 ? ("merged" as const) : ("closed" as const),
      headSha: "b".repeat(40),
      headBranch: "feature/work",
      baseBranch: "main",
      autoMergeEnabled: false,
      waitingOn: [],
      failures: [],
      baseRepository: "Ogard-Labs/octant",
    }));
    const evaluator = createCoordinatorThreadDoneEvaluator(
      basePorts(prThread, {
        pullRequestLinks: {
          // Insertion order: older closed PR #41 first, replacement merged PR #42 second.
          listForThread: () => [closedLink, mergedLink],
          resolveLink: (query) =>
            query.number === 42 ? mergedLink : query.number === 41 ? closedLink : undefined,
          areSameRepository: () => true,
        },
        observePullRequest,
      }),
    );

    expect(await evaluator(prThread)).toBe(true);
    expect(observePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ number: 42 }),
      expect.anything(),
    );
  });
});
