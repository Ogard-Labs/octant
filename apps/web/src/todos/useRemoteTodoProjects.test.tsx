import { decodeHostId } from "@octant/contracts/host";
import { renderHook, waitFor } from "@testing-library/react";
import type {
  FederatedHostTransportSlot,
  HostFederationTransports,
  RemoteSessionBridge,
} from "@octant/client-runtime";
import { describe, expect, it, vi } from "vitest";
import { todoThreadKey, todoThreadStates } from "./todoThreadModel";
import { useRemoteTodoProjects } from "./useRemoteTodoProjects";

const remoteReads = vi.hoisted(() => ({
  projectBootstrap: vi.fn(),
  chatNavigation: vi.fn(),
  codeNavigation: vi.fn(),
  workNavigation: vi.fn(),
}));

vi.mock("../remote/remoteProductClients", () => ({
  createRemoteProductClients: () => ({
    project: { bootstrap: remoteReads.projectBootstrap },
    chat: { navigation: remoteReads.chatNavigation },
    code: { navigation: remoteReads.codeNavigation },
    workThread: { navigation: remoteReads.workNavigation },
  }),
}));

const hostId = decodeHostId("22222222-2222-4222-8222-222222222222");
const bridge = {} as unknown as RemoteSessionBridge;
const slot: FederatedHostTransportSlot = {
  hostId,
  kind: "remote",
  displayName: "Studio",
  state: { kind: "ready", hostId, displayName: "Studio" },
  bridge,
};
const transports: HostFederationTransports = {
  syncEnabledHosts: async () => undefined,
  list: () => [slot],
  get: () => slot,
  remoteTransportFor: () => undefined,
  disconnectHost: async () => undefined,
  fanOut: async () => [],
  subscribe: () => () => undefined,
  disconnectAll: () => undefined,
};

describe("paired to-do thread navigation", () => {
  it("keeps a completed Chat thread when Code navigation fails", async () => {
    const completedAt = "2026-11-14T10:00:00.000Z";
    remoteReads.projectBootstrap.mockResolvedValue({ active: [] });
    remoteReads.chatNavigation.mockResolvedValue({
      threads: [
        {
          id: "10000000-0000-4000-8000-000000000101",
          title: "Completed paired chat",
          providerInstanceId: "80000000-0000-4000-8000-0000000000b1",
          updatedAt: completedAt,
          lastSequence: 1,
          followUpOpen: false,
          completedAt,
        },
      ],
    });
    remoteReads.codeNavigation.mockRejectedValue(new Error("Code navigation is unavailable"));
    remoteReads.workNavigation.mockResolvedValue({ threads: [], runtime: [] });

    const { result, unmount } = renderHook(() => useRemoteTodoProjects(transports, 0));
    await waitFor(() => expect(result.current.threadRows).toHaveLength(1));
    const hostRows = result.current.threadRows[0];
    if (hostRows === undefined) throw new Error("The authorized host rows were not retained.");
    expect(hostRows.code).toEqual([]);
    expect(hostRows.chat).toMatchObject([
      { threadId: "10000000-0000-4000-8000-000000000101", completedAt },
    ]);

    const states = todoThreadStates(undefined, [
      { hostId: hostRows.hostId, mode: "chat", rows: hostRows.chat },
    ]);
    expect(
      states.get(
        todoThreadKey({
          hostId: String(hostId),
          mode: "chat",
          threadId: "10000000-0000-4000-8000-000000000101",
        }),
      ),
    ).toMatchObject({ phase: "done", label: "Done" });

    unmount();
  });
});
