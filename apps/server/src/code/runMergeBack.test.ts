import type { CodeThread } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { CodeOperationService, type CodeOperationServiceOptions } from "./codeOperationService";

const ids = {
  thread: "60000000-0000-4000-8000-000000000010",
  checkout: "60000000-0000-4000-8000-000000000011",
  operation: "60000000-0000-4000-8000-000000000012",
  gitOperation: "60000000-0000-4000-8000-000000000013",
  window: "60000000-0000-4000-8000-000000000014",
  project: "60000000-0000-4000-8000-000000000015",
  binding: "60000000-0000-4000-8000-000000000016",
  provider: "60000000-0000-4000-8000-000000000017",
  content: "60000000-0000-4000-8000-000000000018",
  approval: "60000000-0000-4000-8000-000000000019",
};

const now = "2026-08-18T09:00:00.000Z";
const runHead = "a".repeat(40);
const runRoot = "/workspace/.octant-worktrees/run";
const baseRoot = "/workspace/repository";

const thread = {
  id: ids.thread,
  projectId: ids.project,
  bindingRevisionId: ids.binding,
  repositoryId: `repo_${"a".repeat(64)}`,
  checkoutId: ids.checkout,
  title: "Attempt A",
  lifecycle: "active",
  providerInstanceId: ids.provider,
  modelId: "model-a",
  executionPolicy: "full-access",
  permissionPersistence: "current-session",
  deliveryTarget: {
    branchIntent: "octant/attempt-a",
    remoteName: "origin",
    proposedBaseRepository: "octant/octant",
    proposedBaseBranch: "main",
    outcomeKind: "local-implementation",
    confirmedAt: now,
  },
  version: 1,
  createdAt: now,
  updatedAt: now,
} as unknown as CodeThread;

const checkout = {
  id: ids.checkout,
  repositoryId: thread.repositoryId,
  kind: "managed-worktree",
  availability: "available",
  head: { kind: "branch", name: "octant/attempt-a", oid: runHead },
  ownershipReceiptId: "60000000-0000-4000-8000-000000000020",
  observedAt: now,
} as never;

function observation(changedPaths: ReadonlyArray<string>) {
  return {
    status: "ready" as const,
    head: { kind: "branch" as const, name: "octant/attempt-a", oid: runHead },
    stateToken: "b".repeat(64),
    statusEntries: changedPaths.map((path) => ({ path, index: " ", worktree: "M" })),
    changedPaths,
    diff: "",
    diffTruncated: false,
    remotes: [
      { name: "origin", fetch: { kind: "local" as const }, push: { kind: "local" as const } },
    ],
    worktrees: [],
  };
}

function harness(
  options: {
    readonly mergeability?: "clean" | "conflicts" | "nothing-to-merge" | "unknown";
    readonly ahead?: number;
    readonly runUncommitted?: ReadonlyArray<string>;
    readonly base?:
      | { readonly status: "observed"; readonly branch?: string; readonly clean: boolean }
      | { readonly status: "unavailable" };
  } = {},
) {
  const mergeRun = vi.fn(async () => ({ status: "applied" as const, oid: "c".repeat(40) }));
  const base = options.base ?? { status: "observed" as const, branch: "main", clean: true };
  const git = {
    observe: vi.fn(async () => observation(options.runUncommitted ?? [])),
    compareBranch: vi.fn(async () => ({
      status: "ready" as const,
      head: runHead,
      base: "d".repeat(40),
      ahead: options.ahead ?? 2,
      behind: 0,
      mergeability: options.mergeability ?? ("clean" as const),
    })),
    readBranchDiff: vi.fn(async () => ({
      status: "ready" as const,
      paths: ["src/app.ts"],
      diff: "diff --git a/src/app.ts b/src/app.ts",
      diffTruncated: false,
    })),
    mergeRun,
  };
  const service = new CodeOperationService({
    authority: {
      readThread: () => thread,
      readCheckout: () => checkout,
      canAccessProject: async () => true,
      resolveCheckoutRoot: async () => ({
        checkoutRoot: runRoot,
        shell: "/bin/zsh",
        credentialReferences: [],
      }),
      approvalContextDigest: async () => "f".repeat(64),
    },
    approvals: { validate: async () => true },
    git: git as never,
    resolveBaseCheckout: async () =>
      base.status === "observed"
        ? {
            status: "observed" as const,
            checkoutRoot: baseRoot,
            branch: base.branch,
            clean: base.clean,
          }
        : { status: "unavailable" as const },
    evidence: {
      put: () => ({ contentId: ids.content, digest: "e".repeat(64), byteLength: 32 }),
      read: async () => undefined,
    },
    pullRequests: { ensure: vi.fn(), observe: vi.fn() },
    reviewFindings: { record: vi.fn() },
    terminals: { start: vi.fn(), write: vi.fn(), resize: vi.fn(), stop: vi.fn() },
    repositoryTests: { run: vi.fn(), cancel: vi.fn() },
    turns: { start: vi.fn() },
    events: {
      append: vi.fn(),
      replay: vi.fn(() => ({ status: "ok" as const, frames: [], nextCursor: 0 })),
    },
    actor: { kind: "local-user", actorId: "60000000-0000-4000-8000-000000000021" },
    clock: () => now,
    uuid: () => ids.operation,
  } as unknown as CodeOperationServiceOptions);
  return { service, git, mergeRun };
}

const reviewCommand = {
  kind: "review-run",
  operationId: ids.operation,
  threadId: ids.thread,
  checkoutId: ids.checkout,
  gitOperationId: ids.gitOperation,
  maxDiffBytes: 65_536,
} as const;

const mergeCommand = {
  kind: "merge-run",
  operationId: ids.operation,
  threadId: ids.thread,
  checkoutId: ids.checkout,
  gitOperationId: ids.gitOperation,
  confirmation: {
    branch: "octant/attempt-a",
    baseBranch: "main",
    expectedHeadOid: runHead,
  },
  authorization: { kind: "approved", approvalId: ids.approval },
} as const;

describe("reviewing what a run produced", () => {
  it("measures the run against the branch it targets, remote-tracking first", async () => {
    const { service, git } = harness();

    const result = await service.execute(ids.window as never, reviewCommand);

    expect(git.compareBranch).toHaveBeenCalledWith({
      checkoutRoot: runRoot,
      baseRef: "origin/main",
      headRef: "HEAD",
    });
    expect(result).toMatchObject({
      kind: "run-reviewed",
      outcome: {
        branch: "octant/attempt-a",
        baseRef: "origin/main",
        ahead: 2,
        mergeability: "clean",
      },
    });
  });

  it("names the work the run never committed, which no merge would carry", async () => {
    const { service } = harness({ runUncommitted: ["src/draft.ts"] });

    const result = await service.execute(ids.window as never, reviewCommand);

    expect(result).toMatchObject({ outcome: { uncommittedPaths: ["src/draft.ts"] } });
  });
});

describe("bringing a run home", () => {
  it("merges the run's branch in the Project's own checkout", async () => {
    const { service, mergeRun } = harness();

    const result = await service.execute(ids.window as never, mergeCommand);

    expect(mergeRun).toHaveBeenCalledWith({
      checkoutRoot: baseRoot,
      branch: "octant/attempt-a",
      authority: "approved",
    });
    expect(result).toMatchObject({ kind: "git-mutation-state", mutation: "merge-run" });
  });

  it("refuses a checkout with uncommitted work instead of merging over it", async () => {
    const { service, mergeRun } = harness({
      base: { status: "observed", branch: "main", clean: false },
    });

    const result = await service.execute(ids.window as never, mergeCommand);

    expect(result).toMatchObject({
      kind: "operation-failed",
      failure: { category: "stale" },
    });
    expect(mergeRun).not.toHaveBeenCalled();
  });

  it("refuses when Git will not say whether the merge is clean", async () => {
    const { service, mergeRun } = harness({ mergeability: "unknown" });

    expect(await service.execute(ids.window as never, mergeCommand)).toMatchObject({
      kind: "operation-failed",
    });
    expect(mergeRun).not.toHaveBeenCalled();
  });

  it("refuses a run that moved since the caller reviewed it", async () => {
    const { service, mergeRun } = harness();

    await service.execute(ids.window as never, {
      ...mergeCommand,
      confirmation: { ...mergeCommand.confirmation, expectedHeadOid: "f".repeat(40) },
    });

    expect(mergeRun).not.toHaveBeenCalled();
  });

  it("refuses a confirmation that names another thread's branch", async () => {
    const { service, mergeRun } = harness();

    const result = await service.execute(ids.window as never, {
      ...mergeCommand,
      confirmation: { ...mergeCommand.confirmation, branch: "octant/somewhere-else" },
    });

    expect(result).toMatchObject({
      kind: "operation-failed",
      failure: { category: "invalid" },
    });
    expect(mergeRun).not.toHaveBeenCalled();
  });

  it("refuses when the run has nothing to bring", async () => {
    const { service, mergeRun } = harness({ ahead: 0, mergeability: "nothing-to-merge" });

    expect(await service.execute(ids.window as never, mergeCommand)).toMatchObject({
      kind: "operation-failed",
    });
    expect(mergeRun).not.toHaveBeenCalled();
  });
});
