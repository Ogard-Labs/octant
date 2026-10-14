import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventActor,
  THREAD_EXTERNAL_CONTENT_AGGREGATE,
  decodeBindingRevisionId,
  decodeCodeOperationId,
  decodeCodeRepositoryId,
  decodeCodeThread,
  decodeCodeThreadId,
  decodeProjectId,
  decodeThreadRetentionThreadId,
  decodeWindowId,
  type CodeThread,
  type Project,
} from "@octant/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCheckpointCodePort } from "../checkpoint/threadCheckpointPorts";
import { ExternalContentClearStore } from "../context/externalContentClearStore";
import { ExternalContentIngestionStore } from "../context/externalContentIngestionStore";
import {
  ExternalContentTaintProjection,
  readThreadExternalContentTaint,
} from "../context/externalContentTaintProjection";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { rebuildProjection } from "../persistence/projection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { erasePurgedThread } from "../persistence/threadPurge";
import {
  CodeService,
  type CodeForkPoint,
  type CodePersistencePort,
  type CodeServiceOptions,
} from "./codeService";
import {
  createManagedCodeThreadCreationPort,
  deriveManagedWorktreeCheckoutId,
  type ManagedCodeThreadCreationDeps,
} from "./managedCodeThreadCreation";
import { ManagedRootGrantStore } from "./managedRootGrantStore";
import type { CodeForkConversationReader } from "./codeForkHandoff";
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

function observation(
  withManagedWorktree: boolean,
  managedHead: string = fetchedHead,
  managedBranch: string = deliveryBranch,
) {
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
    branch: `refs/heads/${managedBranch}`,
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

function harness(
  options: {
    readonly fetch?: "fetched" | "failed" | "interrupted";
    readonly threads?: ReadonlyArray<CodeThread>;
    readonly forkPoint?: CodeForkPoint;
    /** How a fork's conversation reads; defaults to a source whose history hands over. */
    readonly forkConversation?: CodeForkConversationReader;
    readonly applySourceFiles?: ManagedCodeThreadCreationDeps["applySourceFiles"];
    /** A real journal, for what a creation leaves behind; defaults to a mock. */
    readonly journal?: CodePersistencePort["journal"];
    readonly uuid?: () => string;
    readonly recordExternalContentIngestion?: CodeServiceOptions["recordExternalContentIngestion"];
  } = {},
) {
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
    journal: options.journal ?? journal,
    readCodeSettings: () => undefined,
    readCodeThread: (id) => options.threads?.find((entry) => String(entry.id) === String(id)),
    readCodeThreads: () => [],
    readCodeThreadActivity: () => [],
    readCodeRuntimeWorks: () => [],
    readCodeCheckout: () => undefined,
    readCodeCheckoutAggregateVersion: (id) =>
      options.journal === undefined
        ? 0
        : options.journal.replayAggregate({
            aggregateType: "code-checkout",
            aggregateId: String(id),
            afterVersion: 0,
            limit: 100,
          }).length,
    readCodeCheckouts: () => [],
    readCodeFileReference: () => undefined,
    readCodeFileReferences: () => [],
    readCodeThreadView: () => undefined,
    readProject: () => project,
  };
  const codeService = new CodeService({
    persistence,
    access: { canBrowseProject: () => true, canAccessProject: async () => true },
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
    uuid: options.uuid ?? (() => "60000000-0000-4000-8000-000000000050"),
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
      ...(options.applySourceFiles === undefined
        ? {}
        : { applySourceFiles: options.applySourceFiles }),
    }),
    forkConversation: options.forkConversation ?? readableForkConversation,
    ...(options.recordExternalContentIngestion === undefined
      ? {}
      : { recordExternalContentIngestion: options.recordExternalContentIngestion }),
    ...(options.forkPoint === undefined
      ? {}
      : { forkPoints: { resolve: vi.fn(async () => options.forkPoint as CodeForkPoint) } }),
  });
  return { codeService, git, receipts, journal, repository };
}

const sourceThreadId = decodeCodeThreadId("60000000-0000-4000-8000-000000000070");

/**
 * A source whose conversation through the fork point can be handed over,
 * reporting the source's outside-content mark the way the host's selector does.
 */
const forkConversationMarkedBy =
  (marked: (threadId: string) => boolean): CodeForkConversationReader =>
  ({ source }) => ({
    status: "available",
    blocks: [
      { kind: "conversation-summary", text: "summary" },
      { kind: "user-message", text: "Forked conversation source: {}\nImplement this." },
    ],
    source: {
      mode: "code",
      threadId: String(source.id),
      projectId: String(source.projectId),
      threadVersion: source.version,
      externalContentIngested: marked(String(source.id)),
      point: {},
    },
    omissions: {
      earlierMessages: 0,
      unfinishedReplies: 0,
      missingBodies: 0,
      oversizedBodies: 0,
      emptyBodies: 0,
      attachments: 0,
      truncatedMessages: 0,
      truncatedCharacters: 0,
      sourceTruncatedMessages: 0,
    },
  });

const readableForkConversation = forkConversationMarkedBy(() => false);

/** The thread a fork comes from, as the host holds it. */
function sourceThread(): CodeThread {
  return decodeCodeThread({
    id: sourceThreadId,
    projectId,
    bindingRevisionId,
    repositoryId,
    checkoutId: "60000000-0000-4000-8000-000000000072",
    title: "Source",
    lifecycle: "active",
    providerInstanceId: "60000000-0000-4000-8000-000000000060",
    modelId: "model-a",
    executionPolicy: "full-access",
    permissionPersistence: "project-default",
    deliveryTarget: {
      branchIntent: "feature/source",
      remoteName: "origin",
      proposedBaseRepository: "octant/octant",
      proposedBaseBranch: "development",
      outcomeKind: "opened-pr",
      confirmedAt: now,
    },
    version: 3,
    createdAt: now,
    updatedAt: now,
  });
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
  it("forks a thread onto its own worktree at the files the chosen turn left, uncommitted work included", async () => {
    const recordedRevision = "e".repeat(40);
    const files = { worktree: "f".repeat(40), index: "d".repeat(40) };
    const applySourceFiles = vi.fn(async () => "applied" as const);
    const { codeService, git, repository } = harness({
      threads: [sourceThread()],
      forkPoint: { status: "resolved", head: recordedRevision, files },
      applySourceFiles,
    });
    (git.resolveRef as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "resolved",
      oid: recordedRevision,
    });
    const calls: ReturnType<typeof observation>[] = [
      observation(false),
      observation(false),
      observation(false),
      observation(false),
      observation(true, recordedRevision),
    ];
    // The fork's branch is the host's to name, so the worktree reports
    // whichever one it was created on.
    const forkBranch = () =>
      (git.addWorktree as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.branchIntent as string;
    (repository.observe as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      const next = calls.shift();
      return next === undefined || next.worktrees.length > 1
        ? observation(true, recordedRevision, forkBranch())
        : next;
    });

    const result = await codeService.execute(windowId, {
      kind: "fork-code-thread",
      threadId,
      sourceThreadId,
      throughOperationId: "60000000-0000-4000-8000-000000000071",
      title: "Source (fork)",
    });
    if (result?.kind !== "managed-thread-created")
      throw new Error("expected managed-thread-created");

    // Its own worktree, on its own branch, from the commit the source was on...
    expect(git.addWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ targetPath, startPoint: recordedRevision }),
      expect.any(AbortSignal),
    );
    expect(result.thread.deliveryTarget.branchIntent).not.toBe("feature/source");
    // ...with the files the source had then, committed or not, laid on top.
    expect(applySourceFiles).toHaveBeenCalledWith(
      { worktreeRoot: targetPath, files },
      expect.any(AbortSignal),
    );
    expect(result.thread.forkedFrom).toEqual({
      threadId: sourceThreadId,
      throughOperationId: "60000000-0000-4000-8000-000000000071",
    });
    // A new thread holds no approval receipt, whatever the source was allowed.
    expect(result.thread.executionPolicy).toBe("approval-gated");
    expect(result.thread.permissionPersistence).toBe("current-session");
  });

  it("refuses before creating anything a fork whose conversation cannot be handed over", async () => {
    const forkConversation = vi.fn<CodeForkConversationReader>(() => ({
      status: "unavailable",
      reason: "source-empty",
    }));
    const { codeService, git, journal } = harness({
      threads: [sourceThread()],
      forkPoint: {
        status: "resolved",
        head: "e".repeat(40),
        files: { worktree: "f".repeat(40), index: "d".repeat(40) },
      },
      forkConversation,
    });
    const before = journal.append.mock.calls.length;

    await expect(
      codeService.execute(windowId, {
        kind: "fork-code-thread",
        threadId,
        sourceThreadId,
        throughOperationId: "60000000-0000-4000-8000-000000000071",
        title: "Source (fork)",
      }),
    ).rejects.toMatchObject({
      failure: { message: expect.stringContaining("no readable messages") },
    });
    // The source is read only through the fork point.
    expect(forkConversation).toHaveBeenCalledWith({
      source: expect.objectContaining({ id: sourceThreadId }),
      throughOperationId: "60000000-0000-4000-8000-000000000071",
    });
    expect(git.addWorktree).not.toHaveBeenCalled();
    expect(journal.append.mock.calls.length).toBe(before);
  });

  it("removes the new worktree and creates nothing when the forked files cannot be laid down", async () => {
    const recordedRevision = "e".repeat(40);
    const { codeService, git, receipts, journal, repository } = harness({
      threads: [sourceThread()],
      forkPoint: {
        status: "resolved",
        head: recordedRevision,
        files: { worktree: "f".repeat(40), index: "d".repeat(40) },
      },
      applySourceFiles: vi.fn(async () => "failed" as const),
    });
    (git.resolveRef as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "resolved",
      oid: recordedRevision,
    });
    const calls: ReturnType<typeof observation>[] = [
      observation(false),
      observation(false),
      observation(false),
      observation(false),
      observation(true, recordedRevision),
    ];
    const forkBranch = () =>
      (git.addWorktree as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.branchIntent as string;
    (repository.observe as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      const next = calls.shift();
      return next === undefined || next.worktrees.length > 1
        ? observation(true, recordedRevision, forkBranch())
        : next;
    });

    await expect(
      codeService.execute(windowId, {
        kind: "fork-code-thread",
        threadId,
        sourceThreadId,
        throughOperationId: "60000000-0000-4000-8000-000000000071",
        title: "Source (fork)",
      }),
    ).rejects.toMatchObject({ failure: { message: expect.stringContaining("forked files") } });
    expect(git.addWorktree).toHaveBeenCalled();
    expect([...receipts.records.values()].some((receipt) => receipt.state === "ready")).toBe(false);
    expect(journal.append).not.toHaveBeenCalled();
  });

  it("refuses a fork whose origin is not a thread of the same Project", async () => {
    const { codeService, git } = harness();

    await expect(
      codeService.execute(windowId, {
        ...managedCommand,
        forkedFrom: {
          threadId: sourceThreadId,
          throughOperationId: "60000000-0000-4000-8000-000000000071",
        },
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid" } });
    expect(git.addWorktree).not.toHaveBeenCalled();
  });

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
    expect(result.checkout.head).toMatchObject({ oid: fetchedHead });
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
  it("starts a thread at a recorded revision without fetching, and says where it came from", async () => {
    const recordedRevision = "e".repeat(40);
    const { codeService, receipts, git, repository } = harness({ threads: [sourceThread()] });
    (git.resolveRef as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "resolved",
      oid: recordedRevision,
    });
    const calls: ReturnType<typeof observation>[] = [
      observation(false),
      observation(false),
      observation(false),
      observation(false),
      observation(true, recordedRevision),
    ];
    (repository.observe as ReturnType<typeof vi.fn>).mockImplementation(
      async () => calls.shift() ?? observation(true, recordedRevision),
    );

    const result = await codeService.execute(windowId, {
      ...managedCommand,
      startFromOrigin: false,
      remoteName: undefined,
      sourceRevision: recordedRevision,
      forkedFrom: {
        threadId: "60000000-0000-4000-8000-000000000070",
        throughOperationId: "60000000-0000-4000-8000-000000000071",
      },
    });
    if (result?.kind !== "managed-thread-created")
      throw new Error("expected managed-thread-created");

    // The revision is already in the repository, so returning to it never
    // reaches the network and never depends on where the branch has moved to.
    expect(git.fetchRemote).not.toHaveBeenCalled();
    expect(git.resolveRef).toHaveBeenCalledWith(
      repositoryRoot,
      recordedRevision,
      expect.any(AbortSignal),
    );
    expect(git.addWorktree).toHaveBeenCalledWith(
      {
        repositoryRoot,
        targetPath,
        branchIntent: deliveryBranch,
        startPoint: recordedRevision,
      },
      expect.any(AbortSignal),
    );
    // Provenance names the revision the worktree started from rather than a
    // branch tip that has since moved on.
    expect(receipts.records.get("60000000-0000-4000-8000-000000000020")?.source).toMatchObject({
      mode: "local",
      branch: recordedRevision,
      resolvedHead: recordedRevision,
    });
    expect(result.thread.forkedFrom).toEqual({
      threadId: "60000000-0000-4000-8000-000000000070",
      throughOperationId: "60000000-0000-4000-8000-000000000071",
    });
  });

  it("refuses to fetch a remote while starting from a recorded revision", async () => {
    const { codeService } = harness();
    await expect(
      codeService.execute(windowId, {
        ...managedCommand,
        sourceRevision: "e".repeat(40),
      }),
    ).rejects.toThrow();
  });
});

const decodeActor = Schema.decodeUnknownSync(EventActor);
const directories: Array<string> = [];
const throughOperationId = "60000000-0000-4000-8000-000000000071";
const recordedRevision = "e".repeat(40);

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A host journal with the outside-content projection, where a source can be marked and cleared. */
function markingHost() {
  const directory = mkdtempSync(join(tmpdir(), "octant-fork-mark-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  let nextId = 0;
  const uuid = () => `61000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`;
  const ingestions = new ExternalContentIngestionStore({
    journal,
    connection,
    uuid,
    clock: () => now,
    actor: decodeActor({ kind: "system", actorId: "61000000-0000-4000-8000-100000000000" }),
  });
  const clears = new ExternalContentClearStore({
    journal,
    connection,
    uuid,
    clock: () => now,
    actor: decodeActor({ kind: "local-user", actorId: "61000000-0000-4000-8000-200000000000" }),
  });
  const marked = (id: string) =>
    readThreadExternalContentTaint(connection, id).externalContentIngested;
  return {
    connection,
    journal,
    uuid,
    ingestions,
    marked,
    markSource: () =>
      ingestions.record({
        threadId: sourceThreadId,
        provenance: { origin: "tool-result", sourceLabel: "web-fetch" },
        contentReference: "web-fetch-page-1",
        correlationId: uuid(),
        authorized: true,
      }),
    clearSource: () =>
      clears.clear({
        threadId: sourceThreadId,
        windowId,
        expectedVersion: clears.read(String(sourceThreadId)).version,
        principal: "local-window",
        turn: "idle",
      }),
    marks: (id: string) =>
      journal.replayAggregate({
        aggregateType: THREAD_EXTERNAL_CONTENT_AGGREGATE,
        aggregateId: id,
        afterVersion: 0,
        limit: 100,
      }),
    eventOrder: () =>
      (
        connection
          .prepare("SELECT event_name, aggregate_id FROM event_journal ORDER BY global_sequence")
          .all() as ReadonlyArray<{ readonly event_name: string; readonly aggregate_id: string }>
      ).map((row) => `${row.event_name} ${row.aggregate_id}`),
  };
}

/** A harness whose new worktree reports the branch and revision a fork is created at. */
function forkingHarness(
  host: ReturnType<typeof markingHost>,
  options: Pick<
    Parameters<typeof harness>[0] & object,
    "recordExternalContentIngestion" | "journal"
  > = {},
) {
  const created = harness({
    threads: [sourceThread()],
    forkPoint: {
      status: "resolved",
      head: recordedRevision,
      files: { worktree: "f".repeat(40), index: "d".repeat(40) },
    },
    applySourceFiles: vi.fn(async () => "applied" as const),
    journal: options.journal ?? host.journal,
    uuid: host.uuid,
    forkConversation: forkConversationMarkedBy(host.marked),
    recordExternalContentIngestion:
      options.recordExternalContentIngestion ?? ((input) => host.ingestions.record(input)),
  });
  (created.git.resolveRef as ReturnType<typeof vi.fn>).mockResolvedValue({
    status: "resolved",
    oid: recordedRevision,
  });
  const calls = [observation(false), observation(false), observation(false), observation(false)];
  const forkBranch = () =>
    (created.git.addWorktree as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
      ?.branchIntent as string;
  (created.repository.observe as ReturnType<typeof vi.fn>).mockImplementation(
    async () => calls.shift() ?? observation(true, recordedRevision, forkBranch()),
  );
  return created;
}

const forkCommand = {
  kind: "fork-code-thread",
  threadId,
  sourceThreadId,
  throughOperationId,
  title: "Source (fork)",
} as const;

describe("a thread made from a thread marked with outside content", () => {
  it("marks a fork before the fork exists, naming the thread it came from", async () => {
    const host = markingHost();
    expect(host.markSource()).toMatchObject({ kind: "recorded" });
    const { codeService } = forkingHarness(host);

    const result = await codeService.execute(windowId, forkCommand);
    expect(result.kind).toBe("managed-thread-created");

    expect(host.marked(String(threadId))).toBe(true);
    expect(host.marks(String(threadId)).map((event) => event.payload)).toEqual([
      {
        threadId,
        correlationId: expect.any(String),
        provenance: { origin: "external-content", sourceLabel: "code-fork" },
        contentReference: `code-fork-${sourceThreadId}-${throughOperationId}`,
      },
    ]);
    // There is no moment at which the fork is journaled and its mark is not.
    const order = host.eventOrder();
    expect(order.indexOf(`thread.external-content-ingested@1 ${threadId}`)).toBeLessThan(
      order.indexOf(`code.thread-created@1 ${threadId}`),
    );
  });

  it("marks a thread restored from a marked thread's turn", async () => {
    const host = markingHost();
    host.markSource();
    const { codeService } = forkingHarness(host);
    const restore = createCheckpointCodePort({
      readCodeThread: (id) => (String(id) === String(sourceThreadId) ? sourceThread() : undefined),
      readProject: () => project,
      readOperationStart: () => undefined,
      execute: (window, command) => codeService.execute(window, command),
      uuid: () => String(threadId),
      clock: () => now,
    }).restore;

    await expect(
      restore({
        authenticatedWindowId: windowId,
        sourceThreadId,
        operationId: decodeCodeOperationId(throughOperationId),
        revision: recordedRevision,
        title: "Source (restored)",
      }),
    ).resolves.toEqual({ status: "created", threadId });

    expect(host.marked(String(threadId))).toBe(true);
    expect(host.marks(String(threadId))[0]?.payload).toMatchObject({
      provenance: { origin: "external-content", sourceLabel: "code-fork" },
      contentReference: `code-fork-${sourceThreadId}-${throughOperationId}`,
    });
  });

  it("leaves a fork of an unmarked thread unmarked", async () => {
    const host = markingHost();
    const { codeService } = forkingHarness(host);

    await codeService.execute(windowId, forkCommand);

    expect(host.marked(String(threadId))).toBe(false);
    expect(host.marks(String(threadId))).toEqual([]);
  });

  it("leaves a fork unmarked when a person cleared the source before forking it", async () => {
    const host = markingHost();
    host.markSource();
    expect(host.clearSource()).toMatchObject({ kind: "cleared" });
    const { codeService } = forkingHarness(host);

    await codeService.execute(windowId, forkCommand);

    expect(host.marked(String(threadId))).toBe(false);
  });

  it("keeps the fork's mark through a replay and erases it with the fork's purge", async () => {
    const host = markingHost();
    host.markSource();
    const { codeService } = forkingHarness(host);
    await codeService.execute(windowId, forkCommand);

    rebuildProjection({
      connection: host.connection,
      journal: host.journal,
      projection: new ExternalContentTaintProjection(),
      clock: () => now,
    });
    expect(host.marked(String(threadId))).toBe(true);

    erasePurgedThread({
      connection: host.connection,
      mode: "code",
      threadId: decodeThreadRetentionThreadId(String(threadId)),
    });
    expect(host.marked(String(threadId))).toBe(false);
    expect(host.marks(String(threadId))).toEqual([]);
    // The source keeps its own mark.
    expect(host.marked(String(sourceThreadId))).toBe(true);
  });

  it("refuses the fork, and creates nothing, when its mark cannot be journaled", async () => {
    for (const record of [
      () => ({ kind: "refused", reason: "malformed" }) as const,
      () => {
        throw new Error("journal unavailable");
      },
    ]) {
      const host = markingHost();
      host.markSource();
      const { codeService, git } = forkingHarness(host, { recordExternalContentIngestion: record });

      await expect(codeService.execute(windowId, forkCommand)).rejects.toMatchObject({
        failure: { message: expect.stringContaining("outside content") },
      });
      expect(git.removeWorktree).toHaveBeenCalled();
      expect(host.eventOrder().some((event) => event.startsWith("code.thread-created@1"))).toBe(
        false,
      );
      expect(host.marked(String(threadId))).toBe(false);
    }
  });

  it("refuses a fork under the id a marked Chat thread holds and leaves that thread's mark as it was", async () => {
    const host = markingHost();
    host.markSource();
    host.connection
      .prepare(
        `INSERT INTO event_journal (
          event_id, aggregate_type, aggregate_id, aggregate_version, event_name, event_version,
          correlation_id, actor_kind, actor_id, occurred_at, payload_json, host_id
        ) VALUES (?, 'chat-thread', ?, 1, 'chat.thread-created@1', 1, ?, 'system', ?, ?, ?, 'local')`,
      )
      .run(
        host.uuid(),
        String(threadId),
        host.uuid(),
        host.uuid(),
        now,
        JSON.stringify({ kind: "thread-created", thread: { id: threadId } }),
      );
    host.ingestions.record({
      threadId,
      provenance: { origin: "external-content", sourceLabel: "web" },
      contentReference: "chat-page-1",
      correlationId: host.uuid(),
      authorized: true,
    });
    const chatMark = host.marks(String(threadId)).map((event) => event.payload);
    expect(chatMark).toHaveLength(1);
    const { codeService, git } = forkingHarness(host);

    await expect(codeService.execute(windowId, forkCommand)).rejects.toMatchObject({
      failure: { category: "conflict", message: "That thread ID is already in use." },
    });
    expect(git.removeWorktree).toHaveBeenCalled();
    expect(host.eventOrder().some((event) => event.startsWith("code.thread-created@1"))).toBe(
      false,
    );
    expect(host.marks(String(threadId)).map((event) => event.payload)).toEqual(chatMark);
  });

  it("leaves no mark on a thread whose creation fails after the mark", async () => {
    const host = markingHost();
    host.markSource();
    const failingJournal: CodePersistencePort["journal"] = {
      append: (request) => {
        if (JSON.stringify(request).includes('"eventName":"code.thread-created@1"')) {
          throw new Error("disk full");
        }
        return host.journal.append(request);
      },
      replay: (cursor) => host.journal.replay(cursor),
      replayAggregate: (query) => host.journal.replayAggregate(query),
      transaction: (body) => host.journal.transaction(body),
    };
    const { codeService, git } = forkingHarness(host, { journal: failingJournal });

    await expect(codeService.execute(windowId, forkCommand)).rejects.toMatchObject({
      failure: { category: "interrupted" },
    });
    expect(git.removeWorktree).toHaveBeenCalled();
    expect(host.marked(String(threadId))).toBe(false);
    expect(host.marks(String(threadId))).toEqual([]);
    expect(host.marked(String(sourceThreadId))).toBe(true);
  });
});
