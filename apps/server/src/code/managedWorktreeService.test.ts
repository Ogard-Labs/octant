import {
  CodeCheckoutId,
  decodeBindingRevisionId,
  decodeCodeRepositoryId,
  decodeCodeThreadId,
  decodeProjectId,
  decodeWindowId,
} from "@octant/contracts";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { ManagedRootGrantStore } from "./managedRootGrantStore";
import type {
  CreateManagedWorktreeReceiptInput,
  ManagedWorktreeReceipt,
  ManagedWorktreeReceiptLookup,
  ManagedWorktreeReceiptState,
} from "./managedWorktreeReceiptStore";
import type { RepositoryIdentityObservation } from "./repositoryIdentity";
import {
  ManagedWorktreeService,
  type ManagedWorktreeAuthorityPort,
  type ManagedWorktreeFileSystemPort,
  type ManagedWorktreeGitPort,
  type ManagedWorktreeReceiptPort,
  type ManagedWorktreeRepositoryPort,
} from "./managedWorktreeService";

const decodeCheckoutId = Schema.decodeUnknownSync(CodeCheckoutId);
const repositoryId = decodeCodeRepositoryId(`repo_${"a".repeat(64)}`);
const otherRepositoryId = decodeCodeRepositoryId(`repo_${"b".repeat(64)}`);
const threadId = decodeCodeThreadId("60000000-0000-4000-8000-000000000001");
const checkoutId = decodeCheckoutId("60000000-0000-4000-8000-000000000002");
const windowId = decodeWindowId("60000000-0000-4000-8000-000000000003");
const projectId = decodeProjectId("60000000-0000-4000-8000-000000000004");
const revisionId = decodeBindingRevisionId("60000000-0000-4000-8000-000000000005");
const repositoryRoot = "/workspace/repository";
const parent = { canonicalPath: "/workspace", identity: { device: "10", inode: "20" } };
const targetPath = `/workspace/.octant-worktrees/${repositoryId}/${threadId}`;
const branchIntent = `octant/${threadId}`;
const branchRef = `refs/heads/${branchIntent}`;
const refIntent = "refs/heads/development";
const head = "a".repeat(40);

function repositoryObservation(
  options: {
    readonly repository?: typeof repositoryId;
    readonly root?: string;
    readonly target?: "ready" | "detached" | "locked" | "prunable" | "duplicate" | "wrong-branch";
    readonly targetHead?: string;
    readonly unrelatedDetached?: boolean;
  } = {},
): Extract<RepositoryIdentityObservation, { status: "available" }> {
  const root = options.root ?? repositoryRoot;
  const checkout = {
    status: "present" as const,
    reportedPath: root,
    canonicalPath: root,
    head,
    branch: "refs/heads/development",
    detached: false,
  };
  const managed = {
    status: "present" as const,
    reportedPath: targetPath,
    canonicalPath: targetPath,
    head: options.targetHead ?? head,
    ...(options.target === "detached"
      ? { detached: true as const }
      : {
          branch: options.target === "wrong-branch" ? "refs/heads/other" : branchRef,
          detached: false as const,
        }),
    ...(options.target === "locked" ? { locked: "editor active" } : {}),
    ...(options.target === "prunable" ? { prunable: "missing gitdir" } : {}),
  };
  const unrelatedDetached = {
    status: "present" as const,
    reportedPath: "/workspace/review-checkout",
    canonicalPath: "/workspace/review-checkout",
    head,
    detached: true as const,
  };
  return {
    status: "available" as const,
    repositoryId: String(options.repository ?? repositoryId) as `repo_${string}`,
    repositoryRoot: root,
    commonDirectory: "/workspace/repository/.git",
    objectDirectory: "/workspace/repository/.git/objects",
    checkout,
    worktrees: [
      checkout,
      ...(options.unrelatedDetached ? [unrelatedDetached] : []),
      ...(options.target === undefined
        ? []
        : options.target === "duplicate"
          ? [managed, { ...managed }]
          : [managed]),
    ],
  };
}

class MemoryReceipts implements ManagedWorktreeReceiptPort {
  readonly records = new Map<string, ManagedWorktreeReceipt>();
  readonly events: string[];
  readonly create = vi.fn(async (input: CreateManagedWorktreeReceiptInput) => {
    this.events.push("receipt:creating");
    const receipt: ManagedWorktreeReceipt = {
      version: 1,
      receiptId: "60000000-0000-4000-8000-000000000006",
      ...input,
      state: "creating",
      createdAt: "2026-07-20T12:00:00.000Z",
      updatedAt: "2026-07-20T12:00:00.000Z",
    };
    this.records.set(receipt.receiptId, receipt);
    return receipt;
  });
  readonly load = vi.fn(async (receiptId: string) => this.records.get(receiptId));
  readonly findActive = vi.fn(async (input: ManagedWorktreeReceiptLookup) => {
    const claims = [...this.records.values()].filter(
      (receipt) =>
        receipt.state !== "removed" &&
        receipt.repositoryId === input.repositoryId &&
        receipt.canonicalWorktreePath === input.canonicalWorktreePath,
    );
    if (claims.length > 1) throw new Error("ambiguous receipt");
    const receipt = claims[0];
    if (
      receipt !== undefined &&
      !Object.entries(input).every(
        ([key, value]) => receipt[key as keyof ManagedWorktreeReceiptLookup] === value,
      )
    ) {
      throw new Error("conflicting receipt");
    }
    return receipt;
  });
  readonly transition = vi.fn(async (receiptId: string, state: ManagedWorktreeReceiptState) => {
    this.events.push(`receipt:${state}`);
    const current = this.records.get(receiptId);
    if (current === undefined) throw new Error("missing receipt");
    const next = { ...current, state, updatedAt: "2026-07-20T12:01:00.000Z" };
    this.records.set(receiptId, next);
    return next;
  });

  constructor(events: string[]) {
    this.events = events;
  }
}

function harness(
  options: {
    readonly observations?: readonly ReturnType<typeof repositoryObservation>[];
    readonly pathExists?: boolean;
    readonly branchExists?: boolean;
    readonly refStatus?: "resolved" | "missing" | "ambiguous" | "failed";
    readonly add?: "created" | "rejected" | "throw";
    readonly remove?: "removed" | "rejected" | "throw";
    readonly dirty?: boolean;
    readonly authority?: "eligible" | "active" | "undelivered" | "mismatched" | "unavailable";
    readonly grantClockPosture?: "ok" | "recovery-required";
  } = {},
) {
  const events: string[] = [];
  const observations = [...(options.observations ?? [repositoryObservation()])];
  const repository: ManagedWorktreeRepositoryPort = {
    observe: vi.fn(async () => observations.shift() ?? repositoryObservation()),
  };
  const filesystem: ManagedWorktreeFileSystemPort = {
    observeParent: vi.fn(async () => ({ status: "available" as const, parent })),
    pathExists: vi.fn(async () => options.pathExists ?? false),
  };
  const git: ManagedWorktreeGitPort = {
    fetchRemote: vi.fn(async () => ({ status: "fetched" as const, remoteHead: head })),
    resolveRef: vi.fn(async () =>
      options.refStatus === "missing"
        ? { status: "missing" as const }
        : options.refStatus === "ambiguous"
          ? { status: "ambiguous" as const }
          : options.refStatus === "failed"
            ? { status: "failed" as const }
            : { status: "resolved" as const, oid: head },
    ),
    branchExists: vi.fn(async () => options.branchExists ?? false),
    addWorktree: vi.fn(async () => {
      events.push("git:add");
      if (options.add === "throw") throw new Error("connection lost");
      return { status: options.add === "rejected" ? ("rejected" as const) : ("created" as const) };
    }),
    isDirty: vi.fn(async () => ({ status: "observed" as const, dirty: options.dirty ?? false })),
    removeWorktree: vi.fn(async () => {
      events.push("git:remove");
      if (options.remove === "throw") throw new Error("connection lost");
      return {
        status: options.remove === "rejected" ? ("rejected" as const) : ("removed" as const),
      };
    }),
  };
  const authority: ManagedWorktreeAuthorityPort = {
    observeCleanupEligibility: vi.fn(async () => {
      switch (options.authority) {
        case "active":
          return {
            status: "eligible" as const,
            active: true,
            delivered: true,
            checkoutId,
            repositoryId,
          };
        case "undelivered":
          return {
            status: "eligible" as const,
            active: false,
            delivered: false,
            checkoutId,
            repositoryId,
          };
        case "mismatched":
          return {
            status: "eligible" as const,
            active: false,
            delivered: true,
            checkoutId: decodeCheckoutId("60000000-0000-4000-8000-000000000099"),
            repositoryId,
          };
        case "unavailable":
          return { status: "unavailable" as const };
        default:
          return {
            status: "eligible" as const,
            active: false,
            delivered: true,
            checkoutId,
            repositoryId,
          };
      }
    }),
  };
  const receipts = new MemoryReceipts(events);
  const service = new ManagedWorktreeService({
    grants: new ManagedRootGrantStore(
      () => "60000000-0000-4000-8000-000000000007",
      undefined,
      () => options.grantClockPosture ?? "ok",
    ),
    receipts,
    repository,
    filesystem,
    git,
    authority,
    now: () => 1_000,
  });
  return { service, repository, filesystem, git, authority, receipts, events };
}

const planInput = {
  authenticatedWindowId: windowId,
  projectId,
  bindingRevisionId: revisionId,
  repositoryId,
  repositoryRoot,
  threadId,
  checkoutId,
  branchIntent,
  startPoint: head,
  sourceBranch: "development",
  sourceMode: "local" as const,
} as const;

async function plan(service: ManagedWorktreeService) {
  const result = await service.planCreation(planInput, new AbortController().signal);
  if (result.status !== "planned") throw new Error(`expected plan, received ${result.status}`);
  return result;
}

describe("ManagedWorktreeService", () => {
  it("returns unavailable when host time recovery refuses managed-root grant issuance", async () => {
    const { service, git } = harness({ grantClockPosture: "recovery-required" });

    await expect(service.planCreation(planInput, new AbortController().signal)).resolves.toEqual({
      status: "unavailable",
    });
    expect(git.addWorktree).not.toHaveBeenCalled();
  });

  it("computes the managed sibling path server-side and separates planning from mutation", async () => {
    const { service, git } = harness();

    const result = await plan(service);

    expect(result).toMatchObject({
      status: "planned",
      repositoryId,
      targetPath,
      parent,
      branchIntent,
      startPoint: head,
      grant: { grantId: "60000000-0000-4000-8000-000000000007" },
    });
    expect(git.addWorktree).not.toHaveBeenCalled();
  });

  it("plans creation when an unrelated worktree is intentionally detached", async () => {
    const { service, git } = harness({
      observations: [repositoryObservation({ unrelatedDetached: true })],
    });

    await expect(
      service.planCreation(planInput, new AbortController().signal),
    ).resolves.toMatchObject({ status: "planned", targetPath });
    expect(git.addWorktree).not.toHaveBeenCalled();
  });

  it("records exact source provenance from the authoritative startPoint without refetching", async () => {
    const { service, git, receipts } = harness();

    const result = await service.planCreation(
      {
        ...planInput,
        startFromOrigin: true,
        sourceMode: "origin" as const,
        remoteName: "origin",
        fetchedAt: "2026-07-20T12:00:00.000Z",
      },
      new AbortController().signal,
    );

    expect(result.status).toBe("planned");
    // planCreation must not refetch; the startPoint is authoritative from prepare.
    expect(git.fetchRemote).not.toHaveBeenCalled();

    if (result.status !== "planned") throw new Error("expected creation plan");
    await service.create(
      {
        ...planInput,
        startFromOrigin: true,
        sourceMode: "origin" as const,
        remoteName: "origin",
        fetchedAt: "2026-07-20T12:00:00.000Z",
        grantId: result.grant.grantId,
      },
      new AbortController().signal,
    );
    // create must not refetch either.
    expect(git.fetchRemote).not.toHaveBeenCalled();
    // D1: receipt provenance must match the selected source branch (development),
    // not the delivery branch (octant/<id>). fetchedAt must be preserved.
    expect(receipts.create).toHaveBeenCalledWith(
      expect.objectContaining({
        source: {
          mode: "origin",
          branch: "development",
          remoteName: "origin",
          resolvedHead: head,
          fetchedAt: "2026-07-20T12:00:00.000Z",
        },
      }),
    );
  });

  it("D1: records local source provenance matching the selected source branch, not the delivery branch", async () => {
    const { service, receipts } = harness();

    const result = await service.planCreation(
      { ...planInput, sourceMode: "local" as const },
      new AbortController().signal,
    );
    expect(result.status).toBe("planned");
    if (result.status !== "planned") throw new Error("expected creation plan");
    await service.create(
      { ...planInput, sourceMode: "local" as const, grantId: result.grant.grantId },
      new AbortController().signal,
    );
    // D1: local receipt provenance must match the selected source branch
    // (development), not the delivery branch (octant/<id>).
    expect(receipts.create).toHaveBeenCalledWith(
      expect.objectContaining({
        branchIntent,
        source: {
          mode: "local",
          branch: "development",
          resolvedHead: head,
        },
      }),
    );
  });

  it("writes creating before mutation and marks ready only after fresh identity confirmation", async () => {
    const { service, receipts, git, events } = harness({
      observations: [
        repositoryObservation(),
        repositoryObservation(),
        repositoryObservation({ target: "ready" }),
      ],
    });
    const creationPlan = await plan(service);

    const result = await service.create(
      { ...planInput, grantId: creationPlan.grant.grantId },
      new AbortController().signal,
    );

    expect(result).toMatchObject({ status: "ready", receipt: { state: "ready" }, targetPath });
    expect(events).toEqual(["receipt:creating", "git:add", "receipt:ready"]);
    expect(git.addWorktree).toHaveBeenCalledWith(
      { repositoryRoot, targetPath, branchIntent, startPoint: head },
      expect.any(AbortSignal),
    );
    expect(receipts.create).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryId,
        threadId,
        checkoutId,
        canonicalRepositoryPath: repositoryRoot,
        canonicalWorktreePath: targetPath,
        branchIntent,
        refIntent: branchRef,
        expectedHead: head,
      }),
    );
  });

  it("leaves an interrupted creation receipt in creating and retries only through reconciliation", async () => {
    const { service, receipts, git } = harness({ add: "throw" });
    const creationPlan = await plan(service);

    const interrupted = await service.create(
      { ...planInput, grantId: creationPlan.grant.grantId },
      new AbortController().signal,
    );
    expect(interrupted).toMatchObject({
      status: "interrupted",
      receipt: { state: "creating" },
    });
    expect(receipts.transition).not.toHaveBeenCalled();

    await expect(
      service.create(
        { ...planInput, grantId: creationPlan.grant.grantId },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: "waiting", receipt: { state: "creating" } });
    expect(git.addWorktree).toHaveBeenCalledOnce();
  });

  it("adopts an exact durable creating receipt after a crash without repeating Git mutation", async () => {
    const { service, receipts, git } = harness({
      observations: [repositoryObservation({ target: "ready" })],
    });
    const receipt = await receipts.create({
      repositoryId,
      threadId,
      checkoutId,
      canonicalRepositoryPath: repositoryRoot,
      canonicalWorktreePath: targetPath,
      branchIntent,
      refIntent: branchRef,
      expectedHead: head,
    });

    await expect(
      service.create(
        {
          ...planInput,
          grantId: "60000000-0000-4000-8000-000000000099" as never,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      status: "ready",
      targetPath,
      receipt: { receiptId: receipt.receiptId, state: "ready" },
    });
    expect(git.addWorktree).not.toHaveBeenCalled();
  });

  it("refuses crash adoption when the owned branch no longer points at the persisted head", async () => {
    const { service, receipts, git } = harness({
      observations: [repositoryObservation({ target: "ready", targetHead: "b".repeat(40) })],
    });
    await receipts.create({
      repositoryId,
      threadId,
      checkoutId,
      canonicalRepositoryPath: repositoryRoot,
      canonicalWorktreePath: targetPath,
      branchIntent,
      refIntent: branchRef,
      expectedHead: head,
    });

    await expect(
      service.create(
        {
          ...planInput,
          grantId: "60000000-0000-4000-8000-000000000099" as never,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: "waiting", receipt: { state: "creating" } });
    expect(git.addWorktree).not.toHaveBeenCalled();
    expect(receipts.transition).not.toHaveBeenCalled();
  });

  it("fails closed when another active receipt claims the same managed target", async () => {
    const { service, receipts, git } = harness();
    await receipts.create({
      repositoryId,
      threadId,
      checkoutId,
      canonicalRepositoryPath: repositoryRoot,
      canonicalWorktreePath: targetPath,
      branchIntent: "octant/conflicting-owner",
      refIntent: "refs/heads/octant/conflicting-owner",
      expectedHead: head,
    });

    await expect(
      service.create(
        {
          ...planInput,
          grantId: "60000000-0000-4000-8000-000000000099" as never,
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ status: "interrupted" });
    expect(receipts.create).toHaveBeenCalledOnce();
    expect(git.addWorktree).not.toHaveBeenCalled();
  });

  it.each([
    [
      "moved repository",
      { observations: [repositoryObservation({ root: "/workspace/moved" })] },
      "repository-mismatch",
    ],
    [
      "replaced repository",
      { observations: [repositoryObservation({ repository: otherRepositoryId })] },
      "repository-mismatch",
    ],
    ["path collision", { pathExists: true }, "path-collision"],
    ["branch collision", { branchExists: true }, "branch-collision"],
    [
      "detached inventory",
      { observations: [repositoryObservation({ target: "detached" })] },
      "path-collision",
    ],
    [
      "locked inventory",
      { observations: [repositoryObservation({ target: "locked" })] },
      "inventory-ambiguous",
    ],
    [
      "prunable inventory",
      { observations: [repositoryObservation({ target: "prunable" })] },
      "inventory-ambiguous",
    ],
  ])("refuses %s before issuing a grant", async (_label, options, reason) => {
    const { service, git } = harness(options);

    await expect(
      service.planCreation(planInput, new AbortController().signal),
    ).resolves.toMatchObject({
      status: "refused",
      reason,
    });
    expect(git.addWorktree).not.toHaveBeenCalled();
  });

  it("refuses cleanup without explicit local confirmation or a durable ownership receipt", async () => {
    const { service } = harness();

    await expect(
      service.cleanup(
        { receiptId: "60000000-0000-4000-8000-000000000006", confirmedByLocalUser: false },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ status: "refused", reason: "confirmation-required" });
    await expect(
      service.cleanup(
        { receiptId: "60000000-0000-4000-8000-000000000006", confirmedByLocalUser: true },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ status: "refused", reason: "unowned" });
  });

  it.each([
    ["dirty", { dirty: true, observations: [repositoryObservation({ target: "ready" })] }, "dirty"],
    ["active", { authority: "active" as const }, "active-thread"],
    ["undelivered", { authority: "undelivered" as const }, "undelivered"],
    ["mismatched", { authority: "mismatched" as const }, "mismatched"],
    [
      "locked",
      { observations: [repositoryObservation({ target: "locked" })] },
      "inventory-ambiguous",
    ],
    [
      "detached",
      { observations: [repositoryObservation({ target: "detached" })] },
      "inventory-ambiguous",
    ],
    [
      "prunable",
      { observations: [repositoryObservation({ target: "prunable" })] },
      "inventory-ambiguous",
    ],
    [
      "duplicate",
      { observations: [repositoryObservation({ target: "duplicate" })] },
      "inventory-ambiguous",
    ],
    [
      "wrong branch",
      { observations: [repositoryObservation({ target: "wrong-branch" })] },
      "mismatched",
    ],
  ])("refuses %s cleanup before mutation", async (_label, options, reason) => {
    const { service, receipts, git } = harness(options);
    const receipt = await receipts.create({
      repositoryId,
      threadId,
      checkoutId,
      canonicalRepositoryPath: repositoryRoot,
      canonicalWorktreePath: targetPath,
      branchIntent,
      refIntent: branchRef,
      expectedHead: head,
    });
    await receipts.transition(receipt.receiptId, "ready");

    await expect(
      service.cleanup(
        { receiptId: receipt.receiptId, confirmedByLocalUser: true },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: "refused", reason });
    expect(git.removeWorktree).not.toHaveBeenCalled();
  });

  it("persists cleanup-pending for interruption and completes an idempotent safe retry", async () => {
    const setup = harness({
      observations: [
        repositoryObservation({ target: "ready" }),
        repositoryObservation({ target: "ready" }),
        repositoryObservation(),
      ],
      remove: "throw",
    });
    const receipt = await setup.receipts.create({
      repositoryId,
      threadId,
      checkoutId,
      canonicalRepositoryPath: repositoryRoot,
      canonicalWorktreePath: targetPath,
      branchIntent,
      refIntent: branchRef,
      expectedHead: head,
    });
    await setup.receipts.transition(receipt.receiptId, "ready");

    await expect(
      setup.service.cleanup(
        { receiptId: receipt.receiptId, confirmedByLocalUser: true },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: "interrupted", receipt: { state: "cleanup-pending" } });

    setup.git.removeWorktree = vi.fn(async () => ({ status: "removed" as const }));
    await expect(
      setup.service.cleanup(
        { receiptId: receipt.receiptId, confirmedByLocalUser: true },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: "removed", receipt: { state: "removed" } });
    const removeCalls = vi.mocked(setup.git.removeWorktree).mock.calls.length;

    await expect(
      setup.service.cleanup(
        { receiptId: receipt.receiptId, confirmedByLocalUser: true },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: "removed", receipt: { state: "removed" } });
    expect(setup.git.removeWorktree).toHaveBeenCalledTimes(removeCalls);
  });

  it("keeps cleanup pending when Git inventory is gone but the owned path still exists", async () => {
    const setup = harness({ pathExists: true });
    const receipt = await setup.receipts.create({
      repositoryId,
      threadId,
      checkoutId,
      canonicalRepositoryPath: repositoryRoot,
      canonicalWorktreePath: targetPath,
      branchIntent,
      refIntent: branchRef,
      expectedHead: head,
    });
    await setup.receipts.transition(receipt.receiptId, "cleanup-pending");

    await expect(
      setup.service.cleanup(
        { receiptId: receipt.receiptId, confirmedByLocalUser: true },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: "waiting", receipt: { state: "cleanup-pending" } });
    expect(setup.git.removeWorktree).not.toHaveBeenCalled();
  });
});

describe("ManagedWorktreeService.previewSource", () => {
  const previewInput = {
    repositoryId,
    repositoryRoot,
    refIntent,
    startFromOrigin: true,
    remoteName: "origin",
  } as const;

  it("fetches and resolves the exact remote-tracking SHA without creating anything", async () => {
    const { service, git, receipts } = harness();

    await expect(
      service.previewSource(previewInput, new AbortController().signal),
    ).resolves.toEqual({
      status: "origin",
      remoteName: "origin",
      branch: "development",
      resolvedHead: head,
      fetchedAt: "1970-01-01T00:00:01.000Z",
    });
    expect(git.fetchRemote).toHaveBeenCalledWith(
      repositoryRoot,
      "origin",
      "development",
      expect.any(AbortSignal),
    );
    expect(git.addWorktree).not.toHaveBeenCalled();
    expect(receipts.create).not.toHaveBeenCalled();
  });

  it("resolves an exact local SHA without fetching", async () => {
    const { service, git } = harness();

    await expect(
      service.previewSource(
        { ...previewInput, startFromOrigin: false },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      status: "local",
      branch: refIntent,
      resolvedHead: head,
      remoteName: "origin",
    });
    expect(git.fetchRemote).not.toHaveBeenCalled();
    expect(git.addWorktree).not.toHaveBeenCalled();
  });

  it("fails closed when origin preview has no usable remote", async () => {
    const { service, git } = harness();

    await expect(
      service.previewSource(
        { repositoryId, repositoryRoot, refIntent, startFromOrigin: true },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ status: "failed", reason: "remote-unavailable" });
    expect(git.fetchRemote).not.toHaveBeenCalled();
  });

  it("maps a rejected fetch to fetch-rejected and an interrupted fetch to cancelled", async () => {
    const rejected = harness();
    rejected.git.fetchRemote = vi.fn(async () => ({ status: "failed" as const }));
    await expect(
      rejected.service.previewSource(previewInput, new AbortController().signal),
    ).resolves.toEqual({ status: "failed", reason: "fetch-rejected" });

    const interrupted = harness();
    interrupted.git.fetchRemote = vi.fn(async () => ({ status: "interrupted" as const }));
    await expect(
      interrupted.service.previewSource(previewInput, new AbortController().signal),
    ).resolves.toEqual({ status: "failed", reason: "cancelled" });
  });

  it("maps local ref resolution failures to typed reasons", async () => {
    const missing = harness({ refStatus: "missing" });
    await expect(
      missing.service.previewSource(
        { ...previewInput, startFromOrigin: false },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ status: "failed", reason: "ref-unavailable" });

    const ambiguous = harness({ refStatus: "ambiguous" });
    await expect(
      ambiguous.service.previewSource(
        { ...previewInput, startFromOrigin: false },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ status: "failed", reason: "ambiguous-ref" });
  });

  it("fails closed when the repository observation does not match", async () => {
    const { service } = harness({
      observations: [repositoryObservation({ repository: otherRepositoryId })],
    });

    await expect(
      service.previewSource(previewInput, new AbortController().signal),
    ).resolves.toEqual({ status: "failed", reason: "unavailable" });
  });
});

describe("ManagedWorktreeService.rollbackCreation", () => {
  const receiptInput = {
    repositoryId,
    threadId,
    checkoutId,
    canonicalRepositoryPath: repositoryRoot,
    canonicalWorktreePath: targetPath,
    branchIntent,
    refIntent,
    expectedHead: head,
  };

  it("removes a just-created worktree and marks the receipt removed", async () => {
    const { service, git, receipts } = harness({
      observations: [repositoryObservation({ target: "ready" })],
    });
    const receipt = await receipts.create(receiptInput);

    await expect(
      service.rollbackCreation(receipt.receiptId, new AbortController().signal),
    ).resolves.toEqual({ status: "removed" });
    expect(git.removeWorktree).toHaveBeenCalledWith(
      { repositoryRoot, targetPath },
      expect.any(AbortSignal),
    );
    expect(receipts.records.get(receipt.receiptId)?.state).toBe("removed");
  });

  it("reports removed when the receipt is already removed", async () => {
    const { service, git, receipts } = harness();
    const receipt = await receipts.create(receiptInput);
    await receipts.transition(receipt.receiptId, "cleanup-pending");
    await receipts.transition(receipt.receiptId, "removed");

    await expect(
      service.rollbackCreation(receipt.receiptId, new AbortController().signal),
    ).resolves.toEqual({ status: "removed" });
    expect(git.removeWorktree).not.toHaveBeenCalled();
  });

  it("returns waiting and leaves cleanup-pending when the worktree cannot be removed", async () => {
    const { service, receipts } = harness({
      observations: [repositoryObservation({ target: "ready" })],
      remove: "rejected",
    });
    const receipt = await receipts.create(receiptInput);

    await expect(
      service.rollbackCreation(receipt.receiptId, new AbortController().signal),
    ).resolves.toEqual({ status: "waiting" });
    expect(receipts.records.get(receipt.receiptId)?.state).toBe("cleanup-pending");
  });

  it("refuses when the receipt is unknown", async () => {
    const { service } = harness();

    await expect(
      service.rollbackCreation(
        "60000000-0000-4000-8000-000000000099",
        new AbortController().signal,
      ),
    ).resolves.toEqual({ status: "refused" });
  });
});
