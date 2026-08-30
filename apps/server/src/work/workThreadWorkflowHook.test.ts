import { describe, expect, it, vi } from "vitest";
import type { WorkThreadBootstrap, WorkThreadCommandResult, WindowId } from "@octant/contracts";
import { withWorkflowLifecycle } from "./workThreadWorkflowHook";
import type { WorkThreadRouteService } from "../workThreadRoutes";

const windowId = "window-1" as unknown as WindowId;

const activeThread = {
  id: "thread-1",
  projectId: "project-1",
  title: "Draft the launch brief",
  lifecycle: "active",
} as const;

const archivedThread = { ...activeThread, lifecycle: "archived" } as const;

function createThreads(
  result: WorkThreadCommandResult,
): WorkThreadRouteService & { readonly executeCalls: Array<unknown> } {
  const executeCalls: Array<unknown> = [];
  return {
    executeCalls,
    bootstrap: async () => ({ threads: [], runtime: [] }) as WorkThreadBootstrap,
    execute: async (_windowId, input) => {
      executeCalls.push(input);
      return result;
    },
  };
}

describe("withWorkflowLifecycle", () => {
  it("starts a workflow after a successful thread-created result", async () => {
    const threads = createThreads({
      kind: "thread-created",
      thread: activeThread,
    } as unknown as WorkThreadCommandResult);
    const recordThreadLifecycle = vi.fn();
    const wrapped = withWorkflowLifecycle({
      threads,
      workflows: { recordThreadLifecycle },
    });
    const result = await wrapped.execute(windowId, { kind: "create-work-thread" });
    expect(result).toEqual({ kind: "thread-created", thread: activeThread });
    expect(recordThreadLifecycle).toHaveBeenCalledWith({
      projectId: activeThread.projectId,
      relatedThreadId: activeThread.id,
      label: activeThread.title,
      lifecycle: "active",
    });
  });

  it("completes the workflow after a successful archive result", async () => {
    const threads = createThreads({
      kind: "thread-updated",
      thread: archivedThread,
    } as unknown as WorkThreadCommandResult);
    const recordThreadLifecycle = vi.fn();
    const wrapped = withWorkflowLifecycle({
      threads,
      workflows: { recordThreadLifecycle },
    });
    await wrapped.execute(windowId, { kind: "change-work-thread-lifecycle" });
    expect(recordThreadLifecycle).toHaveBeenCalledWith({
      projectId: archivedThread.projectId,
      relatedThreadId: archivedThread.id,
      label: archivedThread.title,
      lifecycle: "archived",
    });
  });

  it("does not record a lifecycle fact for a failure result", async () => {
    const threads = createThreads({
      kind: "invalid",
      message: "nope",
    } as unknown as WorkThreadCommandResult);
    const recordThreadLifecycle = vi.fn();
    const wrapped = withWorkflowLifecycle({
      threads,
      workflows: { recordThreadLifecycle },
    });
    await wrapped.execute(windowId, { kind: "create-work-thread" });
    expect(recordThreadLifecycle).not.toHaveBeenCalled();
  });

  it("does not start a replacement workflow for metadata-only thread updates", async () => {
    const threads = createThreads({
      kind: "thread-updated",
      thread: activeThread,
    } as unknown as WorkThreadCommandResult);
    const recordThreadLifecycle = vi.fn();
    const wrapped = withWorkflowLifecycle({
      threads,
      workflows: { recordThreadLifecycle },
    });

    await wrapped.execute(windowId, { kind: "rename-work-thread" });

    expect(recordThreadLifecycle).not.toHaveBeenCalled();
  });

  it("propagates the underlying execute rejection without recording a lifecycle fact", async () => {
    const recordThreadLifecycle = vi.fn();
    const threads: WorkThreadRouteService = {
      bootstrap: async () => ({ threads: [], runtime: [] }) as WorkThreadBootstrap,
      execute: async () => {
        throw new Error("thread service unavailable");
      },
    };
    const wrapped = withWorkflowLifecycle({
      threads,
      workflows: { recordThreadLifecycle },
    });
    await expect(wrapped.execute(windowId, { kind: "create-work-thread" })).rejects.toThrow(
      "thread service unavailable",
    );
    expect(recordThreadLifecycle).not.toHaveBeenCalled();
  });

  it("never lets a workflow-tracking failure surface from execute", async () => {
    const threads = createThreads({
      kind: "thread-created",
      thread: activeThread,
    } as unknown as WorkThreadCommandResult);
    const recordThreadLifecycle = vi.fn(() => {
      throw new Error("workflow store unavailable");
    });
    const wrapped = withWorkflowLifecycle({
      threads,
      workflows: { recordThreadLifecycle },
    });
    const result = await wrapped.execute(windowId, { kind: "create-work-thread" });
    expect(result).toEqual({ kind: "thread-created", thread: activeThread });
  });

  it("delegates bootstrap unchanged", async () => {
    const threads = createThreads({
      kind: "invalid",
      message: "n/a",
    } as unknown as WorkThreadCommandResult);
    const wrapped = withWorkflowLifecycle({
      threads,
      workflows: { recordThreadLifecycle: vi.fn() },
    });
    await expect(wrapped.bootstrap(windowId)).resolves.toEqual({ threads: [], runtime: [] });
  });
});
