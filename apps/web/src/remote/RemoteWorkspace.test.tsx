import type { ReplicaSyncStatusClient } from "@octant/client-runtime/replica-sync-status-client";
import type { ChatClient } from "@octant/client-runtime/chat-client";
import type { CodeClient } from "@octant/client-runtime/code-client";
import type { ProjectClient } from "@octant/client-runtime/project-client";
import type { ProjectBrowserClient } from "@octant/client-runtime/project-browser-client";
import type { ProjectTerminalClient } from "@octant/client-runtime/project-terminal-client";
import type { ProviderClient } from "@octant/client-runtime/provider-client";
import type { WorkMutationClient } from "@octant/client-runtime/work-mutation-client";
import type { WorkRequestClient } from "@octant/client-runtime/work-request-client";
import type { WorkThreadClient } from "@octant/client-runtime/work-thread-client";
import type { WorkTurnClient } from "@octant/client-runtime/work-turn-client";
import {
  decodeCodeThread,
  decodeWorkThread,
  decodeWorkThreadBootstrap,
  type CodeBootstrap,
} from "@octant/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RemoteWorkspace } from "./RemoteWorkspace";
import type { RemoteProductClients } from "./remoteProductClients";

const now = "2026-08-03T00:00:00.000Z";

function hostCreatedThread() {
  return decodeWorkThread({
    id: "20000000-0000-4000-8000-000000000001",
    projectId: "30000000-0000-4000-8000-000000000002",
    title: "Host brief",
    lifecycle: "active",
    providerInstanceId: "10000000-0000-4000-8000-000000000001",
    modelId: "model-a",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

function unused<T extends object>(label: string): T {
  return new Proxy({} as T, {
    get(_target, property) {
      throw new Error(`${label}.${String(property)} is unused in this test`);
    },
  });
}

function workClients(
  workThread: Pick<WorkThreadClient, "bootstrap" | "navigation">,
  replyDetailRead: RemoteProductClients["replyDetail"]["read"] = async () => undefined,
): RemoteProductClients {
  return {
    chat: unused<ChatClient>("chat"),
    canvas: unused<RemoteProductClients["canvas"]>("canvas"),
    code: unused<CodeClient>("code"),
    syncStatus: unused<ReplicaSyncStatusClient>("syncStatus"),
    project: unused<ProjectClient>("project"),
    provider: {
      bootstrap: async () => ({
        instances: [],
        defaults: { permissionPersistence: "current-session", version: 1 as never },
        observedStates: [],
      }),
      execute: async () => {
        throw new Error("provider.execute is unused");
      },
      probe: async () => {
        throw new Error("provider.probe is unused");
      },
    } satisfies ProviderClient,
    workThread: {
      ...unused<WorkThreadClient>("workThread"),
      bootstrap: workThread.bootstrap,
      navigation: workThread.navigation,
    },
    workTurn: unused<WorkTurnClient>("workTurn"),
    workMutation: unused<WorkMutationClient>("workMutation"),
    workRequest: unused<WorkRequestClient>("workRequest"),
    replyDetail: { read: replyDetailRead, setThreadLevel: async () => undefined },
    canvasImportHtml: async () => {
      throw new Error("canvasImportHtml is unused");
    },
    projectTerminal: unused<ProjectTerminalClient>("projectTerminal"),
    projectBrowser: unused<ProjectBrowserClient>("projectBrowser"),
  };
}

describe("RemoteWorkspace", () => {
  it("lists a host-created Work thread after navigation refresh without remounting", async () => {
    vi.useFakeTimers();
    let threads: ReturnType<typeof hostCreatedThread>[] = [];
    const bootstrap = vi.fn(async () => decodeWorkThreadBootstrap({ threads }));
    const navigation = vi.fn(async () => ({ threads, runtime: [] }));
    render(
      <RemoteWorkspace clients={workClients({ bootstrap, navigation })} connected mode="work" />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(/No Work threads on this host yet/i)).toBeInTheDocument();
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(navigation).not.toHaveBeenCalled();

    threads = [hostCreatedThread()];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(navigation).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Host brief" })).toBeInTheDocument();
    expect(bootstrap).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("reads the host's reply detail when it opens and again when the window regains focus", async () => {
    const read = vi.fn(async () => ({ defaultLevel: "high" as const, threads: [] }));
    const bootstrap = vi.fn(async () => decodeWorkThreadBootstrap({ threads: [] }));
    const navigation = vi.fn(async () => ({ threads: [], runtime: [] }));
    render(
      <RemoteWorkspace
        clients={workClients({ bootstrap, navigation }, read)}
        connected
        mode="work"
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("approves a worker while its coordinator is selected and leaves the coordinator idle and sendable", async () => {
    const projectId = "30000000-0000-4000-8000-000000000009";
    const checkoutId = "31000000-0000-4000-8000-000000000009";
    const coordinator = decodeCodeThread({
      id: "21000000-0000-4000-8000-000000000009",
      projectId,
      bindingRevisionId: "32000000-0000-4000-8000-000000000009",
      repositoryId: `repo_${"a".repeat(64)}`,
      checkoutId,
      title: "Backlog coordinator",
      lifecycle: "active",
      coordinator: true,
      providerInstanceId: "10000000-0000-4000-8000-000000000001",
      modelId: "model-a",
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
      deliveryTarget: {
        branchIntent: "feature/coordinate",
        remoteName: "origin",
        proposedBaseRepository: "octant/octant",
        proposedBaseBranch: "main",
        outcomeKind: "local-implementation",
        confirmedAt: now,
      },
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const checkout = {
      id: checkoutId,
      repositoryId: coordinator.repositoryId,
      kind: "existing-worktree",
      availability: "available",
      head: { kind: "branch", name: "main", oid: "a".repeat(40) },
      observedAt: now,
    };
    const proposal = {
      id: "70000000-0000-4000-8000-000000000109",
      projectId,
      plannerThreadId: coordinator.id,
      fromCoordinator: true,
      title: "Fix the flaky test",
      intent: "Find and fix it.",
      status: "pending",
      proposedAt: now,
      workerOptions: { executionPolicy: "approval-gated" },
    };
    const bootstrap = {
      checkouts: [checkout],
      settings: {
        defaultExecutionPolicy: "approval-gated",
        defaultPermissionPersistence: "current-session",
        requireGitRepository: true,
        defaultDiffLayout: "unified",
        updatedAt: now,
        version: 1,
      },
      threads: [coordinator],
      activity: [],
      runtime: [],
    } as unknown as CodeBootstrap;
    let workerId = "";
    const executeOperation = vi.fn(async (command: { operationId: string }) => ({
      kind: "provider-turn-state",
      operationId: command.operationId,
      state: "running",
    }));
    const code = {
      ...unused<CodeClient>("code"),
      bootstrap: vi.fn(async () => bootstrap),
      navigation: vi.fn(async () => ({ threads: [coordinator], activity: [], runtime: [] })),
      thread: vi.fn(async () => ({ thread: coordinator, checkout, lastSequence: 0 })),
      conversation: vi.fn(async () => ({
        version: 3,
        threadId: coordinator.id,
        turns: [],
        nextCursor: 0,
        hasMore: false,
      })),
      subscribe: vi.fn(async function* (_id: unknown, _cursor: unknown, signal: AbortSignal) {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        yield* [];
      }),
      readFollowUp: vi.fn(async (threadId: string) => ({ threadId, followUpVersion: 0 })),
      readPlanner: vi.fn(async () => ({
        designation: { kind: "none", projectId, updatedAt: now },
        designationVersion: 0,
        proposals: workerId === "" ? [{ proposal, proposalVersion: 1 }] : [],
      })),
      execute: vi.fn(async () => ({
        kind: "checkout-prepared",
        bindingRevisionId: coordinator.bindingRevisionId,
        checkout,
      })),
      executePlannerProposal: vi.fn(async (command: { creation: { threadId: string } }) => {
        workerId = command.creation.threadId;
        return {
          status: "confirmed",
          proposal: { ...proposal, status: "confirmed" },
          creation: {
            kind: "managed-thread-created",
            thread: { ...coordinator, id: workerId, coordinator: undefined },
          },
        };
      }),
      putEvidence: vi.fn(async () => ({
        contentId: "60000000-0000-4000-8000-000000000001",
        digest: "a".repeat(64),
        byteLength: 16,
      })),
      executeOperation,
    } as unknown as CodeClient;
    const clients = {
      ...workClients({
        bootstrap: async () => decodeWorkThreadBootstrap({ threads: [] }),
        navigation: async () => ({ threads: [], runtime: [] }),
      }),
      canvas: {
        ...unused<RemoteProductClients["canvas"]>("canvas"),
        threadReferenceCards: async () => ({ cards: [] }) as never,
      },
      code,
    };
    render(<RemoteWorkspace actsAsHostPerson clients={clients} connected mode="code" />);

    fireEvent.click(await screen.findByRole("button", { name: "Backlog coordinator" }));
    const card = await screen.findByRole("article", {
      name: "Proposed worker: Fix the flaky test",
    });
    fireEvent.click(within(card).getByRole("button", { name: "Approve and start" }));

    await waitFor(() => expect(code.executePlannerProposal).toHaveBeenCalled());
    await screen.findByText("Worker approved and started.");
    // The worker's first turn went to the host for the worker itself.
    expect(executeOperation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "start-provider-turn", threadId: workerId }),
    );
    // The coordinator stays idle: nothing offers to stop it, and its composer sends.
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull());
  });
});
