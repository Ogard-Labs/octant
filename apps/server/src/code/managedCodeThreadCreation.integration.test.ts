import {
  decodeBindingRevisionId,
  decodeCodeRepositoryId,
  decodeCodeThreadId,
  decodeProjectId,
  decodeWindowId,
  type Project,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { CodeService, type CodePersistencePort } from "./codeService";
import {
  createManagedCodeThreadCreationPort,
  deriveManagedWorktreeCheckoutId,
} from "./managedCodeThreadCreation";
import { ManagedRootGrantStore } from "./managedRootGrantStore";
import type {
  ManagedWorktreeAuthorityPort,
  ManagedWorktreeFileSystemPort,
  ManagedWorktreeGitPort,
  ManagedWorktreeRepositoryPort,
} from "./managedWorktreeService";
import { ManagedWorktreeService } from "./managedWorktreeService";
import { CodeContentStore } from "./codeContentStore";
import type {
  CreateManagedWorktreeReceiptInput,
  ManagedWorktreeReceipt,
  ManagedWorktreeReceiptLookup,
  ManagedWorktreeReceiptState,
} from "./managedWorktreeReceiptStore";

const repositoryId = decodeCodeRepositoryId(`repo_${"a".repeat(64)}`);
const threadId = decodeCodeThreadId("60000000-0000-4000-8000-000000000010");
const projectId = decodeProjectId("60000000-0000-4000-8000-000000000011");
const bindingRevisionId = decodeBindingRevisionId("60000000-0000-4000-8000-000000000012");
const windowId = decodeWindowId("60000000-0000-4000-8000-000000000013");
const repositoryRoot = "/workspace/repository";
const parent = { canonicalPath: "/workspace", identity: { device: "10", inode: "20" } };
const fetchedHead = "a1b2c3d4e5f60718293a4b5c6d7e8f9011223344";
const targetPath = `/workspace/.octant-worktrees/${repositoryId}/${threadId}`;
const checkoutId = deriveManagedWorktreeCheckoutId({
  repositoryId: String(repositoryId),
  threadId: String(threadId),
});
const now = "2026-07-30T12:00:00.000Z";

const project = {
  id: projectId,
  type: "code",
  lifecycle: "active",
  binding: { canonicalRoot: repositoryRoot },
  bindingHistory: [
    { revisionId: bindingRevisionId, currentBinding: { canonicalRoot: repositoryRoot } },
  ],
} as unknown as Project;

const deliveryBranch = "feature/managed";

function observation(withManagedWorktree: boolean, managedHead: string = fetchedHead) {
  const checkout = {
    status: "present" as const,
    reportedPath: repositoryRoot,
    canonicalPath: repositoryRoot,
    head: "c".repeat(40),
    branch: "refs/heads/development",
    detached: false,
  };
  const managed = {
    status: "present" as const,
    reportedPath: targetPath,
    canonicalPath: targetPath,
    head: managedHead,
    branch: `refs/heads/${deliveryBranch}`,
    detached: false,
  };
  return {
    status: "available" as const,
    repositoryId: String(repositoryId) as `repo_${string}`,
    repositoryRoot,
    commonDirectory: "/workspace/repository/.git",
    objectDirectory: "/workspace/repository/.git/objects",
    checkout,
    worktrees: withManagedWorktree ? [checkout, managed] : [checkout],
  };
}

class MemoryReceipts {
  readonly records = new Map<string, ManagedWorktreeReceipt>();
  readonly create = vi.fn(async (input: CreateManagedWorktreeReceiptInput) => {
    const receipt: ManagedWorktreeReceipt = {
      version: 1,
      receiptId: "60000000-0000-4000-8000-000000000020",
      ...input,
      state: "creating",
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(receipt.receiptId, receipt);
    return receipt;
  });
  readonly load = vi.fn(async (receiptId: string) => this.records.get(receiptId));
  readonly findActive = vi.fn(async (_input: ManagedWorktreeReceiptLookup) => undefined);
  readonly transition = vi.fn(async (receiptId: string, state: ManagedWorktreeReceiptState) => {
    const current = this.records.get(receiptId);
    if (current === undefined) throw new Error("missing receipt");
    const next = { ...current, state, updatedAt: now };
    this.records.set(receiptId, next);
    return next;
  });
}

function harness(options: { readonly fetch?: "fetched" | "failed" | "interrupted" } = {}) {
  // Observations: prepare repo-id lookup, prepare resolve fresh-state, commit plan fresh-state,
  // commit create fresh-state, commit create confirmation (managed worktree present).
  const observations = [
    observation(false),
    observation(false),
    observation(false),
    observation(false),
    observation(true),
  ];
  const repository: ManagedWorktreeRepositoryPort = {
    observe: vi.fn(async () => observations.shift() ?? observation(true)),
  };
  const filesystem: ManagedWorktreeFileSystemPort = {
    observeParent: vi.fn(async () => ({ status: "available" as const, parent })),
    pathExists: vi.fn(async () => false),
  };
  const git: ManagedWorktreeGitPort = {
    fetchRemote: vi.fn(async () =>
      options.fetch === "failed"
        ? { status: "failed" as const }
        : options.fetch === "interrupted"
          ? { status: "interrupted" as const }
          : { status: "fetched" as const, remoteHead: fetchedHead },
    ),
    resolveRef: vi.fn(async () => ({ status: "resolved" as const, oid: fetchedHead })),
    branchExists: vi.fn(async () => false),
    addWorktree: vi.fn(async () => ({ status: "created" as const })),
    isDirty: vi.fn(async () => ({ status: "observed" as const, dirty: false })),
    removeWorktree: vi.fn(async () => ({ status: "removed" as const })),
    removeCheckpointRefs: vi.fn(async () => {}),
  };
  const authority: ManagedWorktreeAuthorityPort = {
    observeCleanupEligibility: vi.fn(async () => ({
      status: "eligible" as const,
      active: false,
      delivered: true,
      checkoutId,
      repositoryId,
    })),
  };
  const receipts = new MemoryReceipts();
  const service = new ManagedWorktreeService({
    grants: new ManagedRootGrantStore(() => "60000000-0000-4000-8000-000000000030"),
    receipts,
    repository,
    filesystem,
    git,
    authority,
    now: () => new Date(now).getTime(),
  });
  const journal = {
    append: vi.fn(),
    replay: vi.fn(() => []),
    replayAggregate: vi.fn(() => []),
  };
  const persistence: CodePersistencePort = {
    journal,
    readCodeSettings: () => undefined,
    readCodeThread: () => undefined,
    readCodeThreads: () => [],
    readCodeCheckout: () => undefined,
    readCodeCheckoutAggregateVersion: () => 0,
    readCodeCheckouts: () => [],
    readCodeFileReference: () => undefined,
    readCodeFileReferences: () => [],
    readCodeThreadView: () => undefined,
    readProject: () => project,
  };
  const codeService = new CodeService({
    persistence,
    access: { canAccessProject: async () => true },
    checkouts: {
      observe: vi.fn(async () => ({
        bindingRevisionId,
        checkout: observation(false).checkout as never,
      })),
    },
    roots: { resolve: () => undefined },
    files: { open: vi.fn(), save: vi.fn() },
    content: new CodeContentStore({
      maximumBytes: 1024,
      maximumEntries: 4,
      newContentId: () => "60000000-0000-4000-8000-000000000040",
    }),
    uuid: () => "60000000-0000-4000-8000-000000000050",
    clock: () => now,
    workingDirectories: {
      resolve: async () => (project.type === "code" ? project.binding.canonicalRoot : undefined),
    },
    onWorkingDirectoryChanged: async () => undefined,
    managedThreadCreation: createManagedCodeThreadCreationPort({
      readProject: () => project,
      service,
      repository,
      clock: () => now,
    }),
  });
  return { codeService, git, receipts, journal, repository };
}

const managedCommand = {
  kind: "create-managed-code-thread",
  threadId,
  projectId,
  bindingRevisionId,
  title: "Managed work",
  providerInstanceId: "60000000-0000-4000-8000-000000000060",
  modelId: "model-a",
  executionPolicy: "approval-gated",
  permissionPersistence: "current-session",
  deliveryTarget: {
    branchIntent: "feature/managed",
    remoteName: "origin",
    proposedBaseRepository: "octant/octant",
    proposedBaseBranch: "development",
    outcomeKind: "opened-pr",
    confirmedAt: now,
  },
  sourceBranch: "development",
  startFromOrigin: true,
  remoteName: "origin",
} as const;

describe("managed Code thread creation (composer submit -> worktree -> thread binding)", () => {
  it("creates the managed worktree from the fetched remote tip and binds the thread to it", async () => {
    const { codeService, git, receipts, journal } = harness();

    const result = await codeService.execute(windowId, managedCommand);

    // The selected remote source was fetched and resolved server-side.
    expect(git.fetchRemote).toHaveBeenCalledWith(
      repositoryRoot,
      "origin",
      "development",
      expect.any(AbortSignal),
    );
    // A new worktree was created on the confirmed delivery branch from the
    // exact fetched object ID, not the local branch ref.
    expect(git.addWorktree).toHaveBeenCalledWith(
      {
        repositoryRoot,
        targetPath,
        branchIntent: deliveryBranch,
        startPoint: fetchedHead,
      },
      expect.any(AbortSignal),
    );
    // The remote is fetched exactly once during prepare; commit must not refetch.
    expect(git.fetchRemote).toHaveBeenCalledTimes(1);

    if (result?.kind !== "managed-thread-created")
      throw new Error("expected managed-thread-created");
    // The thread is bound to the managed checkout with exact confirmed HEAD and receipt ownership.
    expect(result.thread.id).toBe(threadId);
    expect(result.thread.checkoutId).toBe(checkoutId);
    expect(result.thread.repositoryId).toBe(repositoryId);
    expect(result.thread.version).toBe(1);
    expect(result.checkout.kind).toBe("managed-worktree");
    if (result.checkout.kind !== "managed-worktree") throw new Error("expected managed checkout");
    expect(result.checkout.head).toEqual({
      kind: "branch",
      name: deliveryBranch,
      oid: fetchedHead,
    });
    expect(result.checkout.ownershipReceiptId).toBe("60000000-0000-4000-8000-000000000020");
    // Checkout, receipt provenance, and thread delivery all agree on the delivery branch.
    expect(result.thread.deliveryTarget.branchIntent).toBe(deliveryBranch);
    // Authoritative provenance records the exact fetched SHA, remote, branch, and fetch time.
    expect(result.provenance).toMatchObject({
      mode: "origin",
      remoteName: "origin",
      branch: "development",
      resolvedHead: fetchedHead,
    });
    // The managed checkout and the thread were journaled for replay.
    const appended = journal.append.mock.calls.map(
      (call) => (call[0] as { events: { eventName: string }[] }).events[0]!.eventName,
    );
    expect(appended).toEqual(["code.checkout-observed@1", "code.thread-created@1"]);
    // The receipt transitioned to ready only after HEAD confirmation.
    expect(receipts.transition).toHaveBeenCalledWith(
      "60000000-0000-4000-8000-000000000020",
      "ready",
    );
  });

  it("fails closed without binding a thread when the remote fetch is rejected", async () => {
    const { codeService, git, journal } = harness({ fetch: "failed" });

    await expect(codeService.execute(windowId, managedCommand)).rejects.toMatchObject({
      failure: { category: "unavailable" },
    });
    expect(git.addWorktree).not.toHaveBeenCalled();
    expect(journal.append).not.toHaveBeenCalled();
  });

  it("creates from the exact fetched OID when local development is stale/different", async () => {
    // The local branch ref resolves to a stale head that differs from the fetched remote tip.
    const staleLocalHead = "0".repeat(40);
    const { codeService, git, receipts } = harness();

    // Override resolveRef to return the stale local head; the fetched remote tip wins.
    (git.resolveRef as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "resolved",
      oid: staleLocalHead,
    });

    const result = await codeService.execute(windowId, managedCommand);

    // The remote is fetched exactly once during prepare; commit must not refetch.
    expect(git.fetchRemote).toHaveBeenCalledTimes(1);
    // addWorktree receives the exact fetched OID, never the stale local ref.
    expect(git.addWorktree).toHaveBeenCalledWith(
      {
        repositoryRoot,
        targetPath,
        branchIntent: deliveryBranch,
        startPoint: fetchedHead,
      },
      expect.any(AbortSignal),
    );
    // The local branch ref was never mutated.
    expect(git.resolveRef).not.toHaveBeenCalled();
    if (result?.kind !== "managed-thread-created")
      throw new Error("expected managed-thread-created");
    // HEAD and receipt provenance agree on the fetched OID, not the stale local head.
    expect(result.checkout.head.oid).toBe(fetchedHead);
    expect(result.provenance.resolvedHead).toBe(fetchedHead);
    // The receipt's expectedHead is the fetched OID.
    const receipt = receipts.records.get("60000000-0000-4000-8000-000000000020");
    expect(receipt?.expectedHead).toBe(fetchedHead);
    expect(receipt?.source?.resolvedHead).toBe(fetchedHead);
  });

  it("D1: origin receipt/result/replay provenance matches selected source branch, not delivery branch", async () => {
    const { codeService, receipts } = harness();

    const result = await codeService.execute(windowId, managedCommand);
    if (result?.kind !== "managed-thread-created")
      throw new Error("expected managed-thread-created");

    // D1: receipt source provenance must match the selected source branch (development),
    // not the delivery branch (feature/managed). fetchedAt must be present.
    const receipt = receipts.records.get("60000000-0000-4000-8000-000000000020");
    expect(receipt?.source).toMatchObject({
      mode: "origin",
      branch: "development",
      remoteName: "origin",
      resolvedHead: fetchedHead,
    });
    expect(receipt?.source?.fetchedAt).toBeDefined();

    // D1: thread result provenance must match the receipt source provenance.
    expect(result.provenance).toMatchObject({
      mode: "origin",
      branch: "development",
      remoteName: "origin",
      resolvedHead: fetchedHead,
    });
    // D1: the checkout branch is the delivery branch, distinct from the source.
    expect(result.checkout.kind).toBe("managed-worktree");
    if (result.checkout.kind !== "managed-worktree") throw new Error("expected managed checkout");
    expect(result.checkout.head).toEqual({
      kind: "branch",
      name: deliveryBranch,
      oid: fetchedHead,
    });
    // D1: thread delivery target is the delivery branch, not the source.
    expect(result.thread.deliveryTarget.branchIntent).toBe(deliveryBranch);
  });

  it("D1: local receipt/result provenance matches selected source branch when startFromOrigin is false", async () => {
    const localHead = "d".repeat(40);
    const { codeService, receipts, git, repository } = harness();
    // Override resolveRef to return the local head for the local source path.
    (git.resolveRef as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "resolved",
      oid: localHead,
    });
    // Override the repository observations so the managed worktree head in the
    // confirmation observation matches the local resolved head. The prepare and
    // plan/create fresh-state observations must not see a managed worktree yet.
    const calls: ReturnType<typeof observation>[] = [];
    (repository.observe as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      const next = calls.shift();
      if (next !== undefined) return next;
      return observation(true, localHead);
    });
    // First 4 observations: no managed worktree. 5th: managed worktree with localHead.
    calls.push(observation(false));
    calls.push(observation(false));
    calls.push(observation(false));
    calls.push(observation(false));
    calls.push(observation(true, localHead));

    const localCommand = {
      ...managedCommand,
      startFromOrigin: false,
      remoteName: undefined,
    };
    const result = await codeService.execute(windowId, localCommand);
    if (result?.kind !== "managed-thread-created")
      throw new Error("expected managed-thread-created");

    // D1: local receipt source provenance must match the selected source branch.
    const receipt = receipts.records.get("60000000-0000-4000-8000-000000000020");
    expect(receipt?.source).toMatchObject({
      mode: "local",
      branch: "development",
      resolvedHead: localHead,
    });
    // D1: thread result provenance must match the receipt source provenance.
    expect(result.provenance).toMatchObject({
      mode: "local",
      branch: "development",
      resolvedHead: localHead,
    });
    // D1: the checkout branch is the delivery branch, distinct from the source.
    expect(result.thread.deliveryTarget.branchIntent).toBe(deliveryBranch);
  });
});
