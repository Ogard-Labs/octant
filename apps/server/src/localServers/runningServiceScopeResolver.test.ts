import { describe, expect, it, vi } from "vitest";
import type { CodeCheckoutIdentity, CodeThread, WindowId } from "@octant/contracts";
import {
  createRunningServiceScopeResolver,
  RUNNING_SERVICE_THREAD_LIMIT,
  type RunningServiceSource,
} from "./runningServiceScopeResolver";

const windowId = "44444444-4444-4444-8444-444444444444" as WindowId;
const codeProjectId = "22222222-2222-4222-8222-222222222222";
const workProjectId = "22222222-2222-4222-8222-222222222223";

const bootstrap = {
  active: [
    {
      id: codeProjectId,
      name: "Octant",
      type: "code",
      lifecycle: "active",
      binding: { canonicalRoot: "/repo" },
    },
    {
      id: workProjectId,
      name: "Notes",
      type: "work",
      lifecycle: "active",
      binding: { canonicalRoot: "/notes" },
    },
  ],
};

function thread(id: string, overrides: Record<string, unknown> = {}): CodeThread {
  return {
    id,
    projectId: codeProjectId,
    checkoutId: `checkout-${id}`,
    title: `Thread ${id}`,
    lifecycle: "active",
    executionPolicy: "approval-gated",
    ...overrides,
  } as unknown as CodeThread;
}

const managed = (id: string, head: unknown) =>
  ({
    id: `checkout-${id}`,
    kind: "managed-worktree",
    ownershipReceiptId: `receipt-${id}`,
    head,
  }) as unknown as CodeCheckoutIdentity;

function resolver(source: Partial<RunningServiceSource>) {
  return createRunningServiceScopeResolver({
    projects: { bootstrap: vi.fn().mockResolvedValue(bootstrap) } as never,
    source: {
      readThreads: () => [],
      readCheckout: () => undefined,
      managedWorktreeRoot: async () => undefined,
      ownedPids: () => new Set<number>(),
      ...source,
    },
  });
}

describe("running services scope", () => {
  it("attributes to active Code Projects only, never to a Work Project's folder", async () => {
    const binding = await resolver({}).resolve(windowId);
    expect(binding?.origins).toEqual([
      { root: "/repo", projectId: codeProjectId, projectName: "Octant", posture: "approval-gated" },
    ]);
  });

  it("names a thread's own worktree with its title, branch, and posture", async () => {
    const binding = await resolver({
      readThreads: () => [thread("a", { executionPolicy: "plan" })],
      readCheckout: () => managed("a", { kind: "branch", name: "fix/login", oid: "0".repeat(40) }),
      managedWorktreeRoot: async () => "/repo/.worktrees/a",
    }).resolve(windowId);

    expect(binding?.origins[1]).toEqual({
      root: "/repo/.worktrees/a",
      projectId: codeProjectId,
      projectName: "Octant",
      thread: { threadId: "a", title: "Thread a" },
      branch: "fix/login",
      posture: "plan",
    });
  });

  it("leaves out a worktree its receipt does not vouch for, an archived thread, and a thread outside the window's Projects", async () => {
    const binding = await resolver({
      readThreads: () => [
        thread("unproven"),
        thread("archived", { lifecycle: "archived" }),
        thread("foreign", { projectId: "22222222-2222-4222-8222-222222222999" }),
      ],
      readCheckout: (id) => managed(String(id).replace("checkout-", ""), { kind: "none" }),
      managedWorktreeRoot: async (candidate) =>
        candidate.id === ("unproven" as never) ? undefined : "/repo/.worktrees/other",
    }).resolve(windowId);

    expect(binding?.origins.map((origin) => origin.root)).toEqual(["/repo"]);
  });

  it("reads no more thread worktrees than its bound, however long the history", async () => {
    const managedWorktreeRoot = vi.fn(async () => undefined);
    await resolver({
      readThreads: () =>
        Array.from({ length: RUNNING_SERVICE_THREAD_LIMIT + 50 }, (_, index) =>
          thread(String(index)),
        ),
      readCheckout: (id) => managed(String(id).replace("checkout-", ""), { kind: "none" }),
      managedWorktreeRoot,
    }).resolve(windowId);

    expect(managedWorktreeRoot).toHaveBeenCalledTimes(RUNNING_SERVICE_THREAD_LIMIT);
  });
});
