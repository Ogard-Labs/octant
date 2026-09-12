import type { ChatClient } from "@octant/client-runtime/chat-client";
import type { CodeClient } from "@octant/client-runtime/code-client";
import type { ProjectClient } from "@octant/client-runtime/project-client";
import type { ProviderClient } from "@octant/client-runtime/provider-client";
import type { WorkMutationClient } from "@octant/client-runtime/work-mutation-client";
import type { WorkRequestClient } from "@octant/client-runtime/work-request-client";
import type { WorkThreadClient } from "@octant/client-runtime/work-thread-client";
import type { WorkTurnClient } from "@octant/client-runtime/work-turn-client";
import { decodeWorkThread, decodeWorkThreadBootstrap } from "@octant/contracts";
import { act, render, screen } from "@testing-library/react";
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
): RemoteProductClients {
  return {
    chat: unused<ChatClient>("chat"),
    code: unused<CodeClient>("code"),
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
});
