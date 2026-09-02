import {
  decodeCodeCheckoutId,
  decodeCodeThreadId,
  decodeProjectId,
  decodeWindowId,
  type ProjectBootstrap,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { CodeEnvironmentService } from "./codeEnvironmentService";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000801");
const codeProjectId = decodeProjectId("00000000-0000-4000-8000-000000000802");
const chatProjectId = decodeProjectId("00000000-0000-4000-8000-000000000803");
const archivedCodeProjectId = decodeProjectId("00000000-0000-4000-8000-000000000804");
const missingProjectId = decodeProjectId("00000000-0000-4000-8000-000000000805");
const codeThreadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000806");
const codeCheckoutId = decodeCodeCheckoutId("00000000-0000-4000-8000-000000000807");
const observedAt = "2026-07-16T10:00:00.000Z";

describe("CodeEnvironmentService", () => {
  it("observes Git only for an active Code Project selected from authenticated bootstrap", async () => {
    const controller = new AbortController();
    const git = {
      observe: vi.fn().mockResolvedValue({
        status: "ready",
        repositoryRoot: "/repo",
        worktreeRoot: "/repo/.agent-worktrees/issue-52",
        branch: { kind: "named", name: "feature/issue-52" },
        changes: "dirty",
      }),
    };
    const service = serviceFixture(git);

    await expect(
      (
        service.observe as unknown as (
          authenticatedWindowId: typeof windowId,
          projectId: typeof codeProjectId,
          signal: AbortSignal,
        ) => ReturnType<typeof service.observe>
      )(windowId, codeProjectId, controller.signal),
    ).resolves.toMatchObject({
      status: "ready",
      projectId: codeProjectId,
      projectName: "Octant",
      repositoryRoot: "/repo",
      worktreeRoot: "/repo/.agent-worktrees/issue-52",
      branch: { kind: "named", name: "feature/issue-52" },
      changes: "dirty",
      observedAt,
    });
    expect(git.observe).toHaveBeenCalledWith("/repo/.agent-worktrees/issue-52");
  });

  it("rejects Chat, archived Code, and missing Projects before observing Git", async () => {
    const git = { observe: vi.fn() };
    const service = serviceFixture(git);

    await expect(service.observe(windowId, chatProjectId)).rejects.toMatchObject({
      failure: { category: "invalid" },
    });
    await expect(service.observe(windowId, archivedCodeProjectId)).rejects.toMatchObject({
      failure: { category: "invalid" },
    });
    await expect(service.observe(windowId, missingProjectId)).rejects.toMatchObject({
      failure: { category: "not-found" },
    });
    expect(git.observe).not.toHaveBeenCalled();
  });

  it.each([
    ["unavailable", "Git is not initialized or the Project root is unavailable."],
    ["failed", "Octant could not inspect Git state."],
  ] as const)("normalizes %s results without exposing raw Git details", async (status, reason) => {
    const rawPath = "/Users/private/repository";
    const rawError = `fatal: unsafe repository at ${rawPath}`;
    const git = {
      observe: vi.fn().mockResolvedValue({ status, rawPath, stderr: rawError }),
    };
    const service = serviceFixture(git);

    const result = await service.observe(windowId, codeProjectId);

    expect(result).toEqual({
      status,
      projectId: codeProjectId,
      projectName: "Octant",
      observedAt,
      reason,
    });
    if (result.status === "ready") throw new Error(`Expected ${status} observation.`);
    expect(result.reason).not.toContain(rawPath);
    expect(result.reason).not.toContain(rawError);
  });

  it("observes the checkout selected by an authorized Code thread", async () => {
    const controller = new AbortController();
    const git = {
      observe: vi.fn().mockResolvedValue({
        status: "ready",
        repositoryRoot: "/repo",
        worktreeRoot: "/repo/.octant-worktrees/issue-204",
        branch: { kind: "named", name: "feature/issue-204" },
        changes: "dirty",
      }),
    };
    const service = serviceFixture(git, {
      readThread: vi.fn(() => ({
        id: codeThreadId,
        projectId: codeProjectId,
        checkoutId: codeCheckoutId,
      })),
      readCheckout: vi.fn(() => ({
        id: codeCheckoutId,
        kind: "managed-worktree",
        availability: "available",
      })),
      resolveCheckoutRoot: vi.fn().mockResolvedValue("/repo/.octant-worktrees/issue-204"),
    });

    await expect(
      service.observeThread(windowId, codeProjectId, codeThreadId, controller.signal),
    ).resolves.toMatchObject({
      status: "ready",
      projectId: codeProjectId,
      threadId: codeThreadId,
      checkoutId: codeCheckoutId,
      worktreeRoot: "/repo/.octant-worktrees/issue-204",
    });
    expect(git.observe).toHaveBeenCalledWith("/repo/.octant-worktrees/issue-204");
  });

  it("coalesces simultaneous clients and reuses the recent Git observation", async () => {
    const pending = deferred<{
      readonly status: "ready";
      readonly repositoryRoot: string;
      readonly worktreeRoot: string;
      readonly branch: { readonly kind: "named"; readonly name: string };
      readonly changes: "clean";
    }>();
    const git = { observe: vi.fn(() => pending.promise) };
    const code = {
      readThread: vi.fn(() => ({
        id: codeThreadId,
        projectId: codeProjectId,
        checkoutId: codeCheckoutId,
      })),
      readCheckout: vi.fn(() => ({
        id: codeCheckoutId,
        kind: "managed-worktree",
        availability: "available",
      })),
      resolveCheckoutRoot: vi.fn().mockResolvedValue("/repo/shared"),
    };
    const service = serviceFixture(git, code);

    const first = service.observeThread(windowId, codeProjectId, codeThreadId);
    const second = service.observeThread(windowId, codeProjectId, codeThreadId);
    await vi.waitFor(() => expect(git.observe).toHaveBeenCalledOnce());
    pending.resolve({
      status: "ready",
      repositoryRoot: "/repo",
      worktreeRoot: "/repo/shared",
      branch: { kind: "named", name: "feature/shared" },
      changes: "clean",
    });
    await Promise.all([first, second]);
    await service.observeThread(windowId, codeProjectId, codeThreadId);
    expect(git.observe).toHaveBeenCalledOnce();
  });

  it("keeps a slow Git observation coalesced after the completed-result TTL would have elapsed", async () => {
    let now = 0;
    const pending = deferred<{
      readonly status: "ready";
      readonly repositoryRoot: string;
      readonly worktreeRoot: string;
      readonly branch: { readonly kind: "named"; readonly name: string };
      readonly changes: "clean";
    }>();
    const git = { observe: vi.fn(() => pending.promise) };
    const code = {
      readThread: vi.fn(() => ({
        id: codeThreadId,
        projectId: codeProjectId,
        checkoutId: codeCheckoutId,
      })),
      readCheckout: vi.fn(() => ({
        id: codeCheckoutId,
        kind: "managed-worktree",
        availability: "available",
      })),
      resolveCheckoutRoot: vi.fn().mockResolvedValue("/repo/slow"),
    };
    const service = serviceFixture(git, code, { cacheMs: 5, now: () => now });

    const first = service.observeThread(windowId, codeProjectId, codeThreadId);
    await vi.waitFor(() => expect(git.observe).toHaveBeenCalledOnce());
    now = 10;
    const second = service.observeThread(windowId, codeProjectId, codeThreadId);
    expect(git.observe).toHaveBeenCalledOnce();
    pending.resolve({
      status: "ready",
      repositoryRoot: "/repo",
      worktreeRoot: "/repo/slow",
      branch: { kind: "named", name: "feature/slow" },
      changes: "clean",
    });

    await Promise.all([first, second]);
    expect(git.observe).toHaveBeenCalledOnce();
  });

  it("does not let one canceled caller poison a shared Git observation", async () => {
    const pending = deferred<{
      readonly status: "ready";
      readonly repositoryRoot: string;
      readonly worktreeRoot: string;
      readonly branch: { readonly kind: "named"; readonly name: string };
      readonly changes: "clean";
    }>();
    const git = {
      observe: vi.fn((_root: string, signal?: AbortSignal) => {
        signal?.addEventListener(
          "abort",
          () => pending.reject(new Error("first caller canceled")),
          { once: true },
        );
        return pending.promise;
      }),
    };
    const code = {
      readThread: vi.fn(() => ({
        id: codeThreadId,
        projectId: codeProjectId,
        checkoutId: codeCheckoutId,
      })),
      readCheckout: vi.fn(() => ({
        id: codeCheckoutId,
        kind: "managed-worktree",
        availability: "available",
      })),
      resolveCheckoutRoot: vi.fn().mockResolvedValue("/repo/shared"),
    };
    const service = serviceFixture(git, code);
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = service.observeThread(
      windowId,
      codeProjectId,
      codeThreadId,
      firstController.signal,
    );
    const firstOutcome = first.catch(() => undefined);
    const second = service.observeThread(
      windowId,
      codeProjectId,
      codeThreadId,
      secondController.signal,
    );
    await vi.waitFor(() => expect(git.observe).toHaveBeenCalledOnce());
    firstController.abort();
    pending.resolve({
      status: "ready",
      repositoryRoot: "/repo",
      worktreeRoot: "/repo/shared",
      branch: { kind: "named", name: "feature/shared" },
      changes: "clean",
    });

    await expect(second).resolves.toMatchObject({ status: "ready" });
    await firstOutcome;
  });

  it("evicts old roots from the bounded Git observation cache", async () => {
    const git = {
      observe: vi.fn(async (root: string) => ({
        status: "ready" as const,
        repositoryRoot: "/repo",
        worktreeRoot: root,
        branch: { kind: "named" as const, name: "feature/cache" },
        changes: "clean" as const,
      })),
    };
    const code = {
      readThread: vi.fn(() => ({
        id: codeThreadId,
        projectId: codeProjectId,
        checkoutId: codeCheckoutId,
      })),
      readCheckout: vi.fn(() => ({
        id: codeCheckoutId,
        kind: "managed-worktree",
        availability: "available",
      })),
      resolveCheckoutRoot: vi
        .fn()
        .mockResolvedValueOnce("/repo/one")
        .mockResolvedValueOnce("/repo/two")
        .mockResolvedValueOnce("/repo/one"),
    };
    const service = serviceFixture(git, code, { maxCachedRoots: 1 });

    await service.observeThread(windowId, codeProjectId, codeThreadId);
    await service.observeThread(windowId, codeProjectId, codeThreadId);
    await service.observeThread(windowId, codeProjectId, codeThreadId);

    expect(git.observe).toHaveBeenCalledTimes(3);
  });

  it("bypasses a recent Git observation for an explicit refresh", async () => {
    const git = {
      observe: vi.fn().mockResolvedValue({
        status: "ready",
        repositoryRoot: "/repo",
        worktreeRoot: "/repo/shared",
        branch: { kind: "named", name: "feature/shared" },
        changes: "clean",
      }),
    };
    const service = serviceFixture(git, {
      readThread: vi.fn(() => ({
        id: codeThreadId,
        projectId: codeProjectId,
        checkoutId: codeCheckoutId,
      })),
      readCheckout: vi.fn(() => ({
        id: codeCheckoutId,
        kind: "managed-worktree",
        availability: "available",
      })),
      resolveCheckoutRoot: vi.fn().mockResolvedValue("/repo/shared"),
    });

    await service.observeThread(windowId, codeProjectId, codeThreadId);
    await service.observeThread(windowId, codeProjectId, codeThreadId, undefined, true);

    expect(git.observe).toHaveBeenCalledTimes(2);
  });

  it("fails closed when a thread checkout cannot be resolved", async () => {
    const git = { observe: vi.fn() };
    const service = serviceFixture(git, {
      readThread: vi.fn(() => ({
        id: codeThreadId,
        projectId: codeProjectId,
        checkoutId: codeCheckoutId,
      })),
      readCheckout: vi.fn(() => ({
        id: codeCheckoutId,
        kind: "managed-worktree",
        availability: "available",
      })),
      resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
    });

    await expect(
      service.observeThread(windowId, codeProjectId, codeThreadId),
    ).rejects.toMatchObject({ failure: { category: "unavailable" } });
    expect(git.observe).not.toHaveBeenCalled();
  });
});

function serviceFixture(
  git: { observe: ReturnType<typeof vi.fn> },
  code?: {
    readonly readThread: ReturnType<typeof vi.fn>;
    readonly readCheckout: ReturnType<typeof vi.fn>;
    readonly resolveCheckoutRoot: ReturnType<typeof vi.fn>;
  },
  cache?: {
    readonly cacheMs?: number;
    readonly maxCachedRoots?: number;
    readonly now?: () => number;
  },
) {
  return new CodeEnvironmentService({
    projects: { bootstrap: vi.fn().mockResolvedValue(bootstrapFixture()) },
    git: git as never,
    clock: () => observedAt,
    ...(code === undefined ? {} : { code: code as never }),
    ...(cache?.maxCachedRoots === undefined ? {} : { maxCachedRoots: cache.maxCachedRoots }),
    ...(cache?.cacheMs === undefined ? {} : { cacheMs: cache.cacheMs }),
    ...(cache?.now === undefined ? {} : { now: cache.now }),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function bootstrapFixture(): ProjectBootstrap {
  const common = {
    pinned: false,
    rank: "0/1" as never,
    version: 1 as never,
    createdAt: observedAt as never,
    updatedAt: observedAt as never,
  };
  return {
    active: [
      {
        ...common,
        id: codeProjectId,
        type: "code",
        name: "Octant",
        lifecycle: "active",
        binding: { canonicalRoot: "/repo/.agent-worktrees/issue-52" },
        bindingRevisionId: "30000000-0000-4000-8000-000000000052" as never,
        codeAccessPersistence: "current-session",
      },
      {
        ...common,
        id: chatProjectId,
        type: "chat",
        name: "Chat",
        lifecycle: "active",
      },
    ],
    archived: [
      {
        ...common,
        id: archivedCodeProjectId,
        type: "code",
        name: "Archived Code",
        lifecycle: "archived",
        binding: { canonicalRoot: "/repo/archived" },
        bindingRevisionId: "30000000-0000-4000-8000-000000000053" as never,
        codeAccessPersistence: "current-session",
      },
    ],
    availability: [],
    memory: [],
  };
}
