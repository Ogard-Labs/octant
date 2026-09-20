import type { AppleToolchainClient } from "@octant/client-runtime/apple-toolchain-client";
import type { AppleSnapshotRequest } from "@octant/contracts/apple-toolchain-rpc";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAppleSimulatorPaneOffer } from "./useAppleSimulatorPaneOffer";

const paneOpenRequest = {
  requestId: "10000000-0000-4000-8000-000000000001",
  simulatorId: "10000000-0000-4000-8000-000000000006",
  requestedAt: "2026-09-20T20:00:00.000Z",
};

function snapshotRequest(threadId: string): AppleSnapshotRequest {
  return {
    kind: "apple-snapshot-request",
    authority: {
      hostId: "4f70656e-4f72-4269-9474-4c6f63616c31",
      mode: "code",
      projectId: "90000000-0000-4000-8000-000000000001",
      providerInstanceId: "90000000-0000-4000-8000-000000000002",
      extension: { kind: "core" },
    } as never,
    threadId: threadId as never,
    checkoutId: "90000000-0000-4000-8000-000000000004" as never,
  };
}

describe("useAppleSimulatorPaneOffer", () => {
  it("reads a pane-open request from the runtime snapshot when an Apple tool is active", async () => {
    const snapshot = vi.fn(async () => ({ paneOpenRequest }));
    const client = { snapshot } as unknown as AppleToolchainClient;
    const { result } = renderHook(() =>
      useAppleSimulatorPaneOffer({
        client,
        enabled: true,
        watch: true,
        activityKey: "call-1:started",
        snapshotRequest: snapshotRequest("90000000-0000-4000-8000-000000000003"),
      }),
    );
    await waitFor(() => expect(result.current).toEqual(paneOpenRequest));
    expect(snapshot).toHaveBeenCalled();
  });

  it("does not keep a previous thread's pane request after the active thread has no Apple tool", async () => {
    const snapshot = vi.fn(async () => ({ paneOpenRequest }));
    const client = { snapshot } as unknown as AppleToolchainClient;
    const { result, rerender } = renderHook(
      (props: {
        readonly watch: boolean;
        readonly activityKey: string;
        readonly snapshotRequest: AppleSnapshotRequest;
      }) =>
        useAppleSimulatorPaneOffer({
          client,
          enabled: true,
          watch: props.watch,
          activityKey: props.activityKey,
          snapshotRequest: props.snapshotRequest,
        }),
      {
        initialProps: {
          watch: true,
          activityKey: "call-1:started",
          snapshotRequest: snapshotRequest("90000000-0000-4000-8000-000000000003"),
        },
      },
    );
    await waitFor(() => expect(result.current).toEqual(paneOpenRequest));
    rerender({
      watch: false,
      activityKey: "",
      snapshotRequest: snapshotRequest("90000000-0000-4000-8000-000000000099"),
    });
    expect(result.current).toBeUndefined();
  });
});
