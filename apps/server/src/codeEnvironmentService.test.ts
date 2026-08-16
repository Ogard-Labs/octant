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
    expect(git.observe).toHaveBeenCalledWith("/repo/.agent-worktrees/issue-52", controller.signal);
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
    expect(git.observe).toHaveBeenCalledWith(
      "/repo/.octant-worktrees/issue-204",
      controller.signal,
    );
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
) {
  return new CodeEnvironmentService({
    projects: { bootstrap: vi.fn().mockResolvedValue(bootstrapFixture()) },
    git: git as never,
    clock: () => observedAt,
    ...(code === undefined ? {} : { code: code as never }),
  });
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
