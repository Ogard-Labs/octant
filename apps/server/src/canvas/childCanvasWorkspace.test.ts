import { describe, expect, it } from "vitest";
import type { AgentRun } from "@octant/contracts";
import { deriveAgentRunChildWorktreeThreadId } from "../agentRun/agentRunChildWorktreePort";
import { deriveManagedWorktreeCheckoutId } from "../code/managedCodeThreadCreation";
import { loadChildCanvasWorkspace } from "./childCanvasWorkspace";

const runId = "12121212-1212-4121-8121-121212121212";
const parentThreadId = "33333333-3333-4333-8333-333333333333";
const projectId = "22222222-2222-4222-8222-222222222222";
const bindingRevisionId = "77777777-7777-4777-8777-777777777777";
const repositoryId = `repo_${"ab".repeat(32)}`;
const worktreeRoot = "/repo/.worktrees/child";
const checkoutRoot = "/repo";

function workRun(): AgentRun {
  return {
    id: runId,
    parentThreadId,
    workspaceReceipt: {
      kind: "work-root",
      mode: "work",
      projectId,
      bindingRevisionId,
      canonicalRoot: "/work",
    },
  } as AgentRun;
}

function codeRun(
  overrides?: Partial<Extract<AgentRun["workspaceReceipt"], { kind: "code-worktree" }>>,
): AgentRun {
  return {
    id: runId,
    parentThreadId,
    workspaceReceipt: {
      kind: "code-worktree",
      mode: "code",
      projectId,
      checkoutRoot,
      worktreeRoot,
      verified: true,
      ...overrides,
    },
  } as AgentRun;
}

describe("loadChildCanvasWorkspace", () => {
  it("binds a Work child to the live Project binding, not a supplied path", async () => {
    const resolved = await loadChildCanvasWorkspace(
      {
        readRun: () => workRun(),
        readProject: () => ({
          id: projectId,
          type: "work",
          lifecycle: "active",
          binding: { canonicalRoot: "/work" },
          bindingHistory: [{ revisionId: bindingRevisionId }],
        }),
        readCodeThread: () => undefined,
        readCodeCheckout: () => undefined,
        loadManagedReceipt: async () => undefined,
      },
      runId,
    );
    expect(resolved.status).toBe("ready");
    if (resolved.status !== "ready") return;
    expect(resolved.binding.workspace).toMatchObject({
      kind: "work-root",
      projectId,
      rootId: bindingRevisionId,
    });
  });

  it("refuses a Work child whose Project is not the run's Project", async () => {
    const resolved = await loadChildCanvasWorkspace(
      {
        readRun: () => workRun(),
        readProject: () => ({
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "work",
          lifecycle: "active",
          binding: { canonicalRoot: "/work" },
          bindingHistory: [{ revisionId: bindingRevisionId }],
        }),
        readCodeThread: () => undefined,
        readCodeCheckout: () => undefined,
        loadManagedReceipt: async () => undefined,
      },
      runId,
    );
    expect(resolved).toEqual({ status: "refused", reason: "foreign-project" });
  });

  it("refuses a Code child whose checkout the host cannot resolve", async () => {
    const resolved = await loadChildCanvasWorkspace(
      {
        readRun: () => codeRun(),
        readProject: () => ({
          id: projectId,
          type: "code",
          lifecycle: "active",
          binding: { canonicalRoot: checkoutRoot },
          bindingHistory: [{ revisionId: bindingRevisionId }],
        }),
        readCodeThread: () => ({
          lifecycle: "active",
          projectId,
          repositoryId,
          bindingRevisionId,
        }),
        readCodeCheckout: () => undefined,
        loadManagedReceipt: async () => undefined,
      },
      runId,
    );
    expect(resolved).toEqual({ status: "refused", reason: "unresolved" });
  });

  it("binds a Code child only when the managed receipt still names the admitted worktree", async () => {
    const checkoutId = String(
      deriveManagedWorktreeCheckoutId({
        repositoryId,
        threadId: deriveAgentRunChildWorktreeThreadId(parentThreadId),
      }),
    );
    const resolved = await loadChildCanvasWorkspace(
      {
        readRun: () => codeRun(),
        readProject: () => ({
          id: projectId,
          type: "code",
          lifecycle: "active",
          binding: { canonicalRoot: checkoutRoot },
          bindingHistory: [{ revisionId: bindingRevisionId }],
        }),
        readCodeThread: () => ({
          lifecycle: "active",
          projectId,
          repositoryId,
          bindingRevisionId,
        }),
        readCodeCheckout: (id) =>
          id === checkoutId
            ? ({
                id: checkoutId,
                repositoryId,
                kind: "managed-worktree",
                availability: "available",
                ownershipReceiptId: "99999999-9999-4999-8999-999999999999",
              } as never)
            : undefined,
        loadManagedReceipt: async () =>
          ({
            state: "ready",
            canonicalWorktreePath: worktreeRoot,
            checkoutId,
            repositoryId,
          }) as never,
      },
      runId,
    );
    expect(resolved.status).toBe("ready");
    if (resolved.status !== "ready") return;
    expect(resolved.binding.workspace).toMatchObject({
      kind: "code-worktree",
      projectId,
      checkoutId,
      verified: true,
    });
  });
});
