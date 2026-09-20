import type { AndroidDiscoverySnapshot } from "@octant/contracts/android-toolchain-rpc";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AndroidEmulatorPane } from "./AndroidEmulatorPane";
import { ids } from "../code/CodeDeliveryPane.test-fixtures";

const emulatorId = "Pixel_8_API_34";

const discovery: AndroidDiscoverySnapshot = {
  sdk: {
    sdkId: "90000000-0000-4000-8000-000000000003" as never,
    available: true,
    sdkRoot: "/sdk",
    adbPath: "/sdk/platform-tools/adb",
    emulatorPath: "/sdk/emulator/emulator",
    discoveredAt: "2026-09-20T20:00:00.000Z" as never,
  },
  emulators: [
    {
      emulatorId: emulatorId as never,
      name: "Pixel 8",
      state: "booted",
      serial: "emulator-5554",
    },
  ],
};

const thread = {
  id: ids.thread,
  projectId: "90000000-0000-4000-8000-000000000001",
  providerInstanceId: "90000000-0000-4000-8000-000000000002",
  executionPolicy: "approval-gated",
};

function uuidFactory() {
  let index = 1;
  return () => `c0000000-0000-4000-8000-${String(index++).padStart(12, "0")}`;
}

function client(overrides: Record<string, unknown> = {}) {
  return {
    discover: vi.fn(async () => discovery),
    snapshot: vi.fn(async () => ({
      sequence: 1,
      snapshotAt: "2026-09-20T20:00:03.000Z",
      sdk: discovery.sdk,
      emulators: discovery.emulators,
      active: [],
      recentEvidence: [],
    })),
    execute: vi.fn(async () => ({ outcome: "succeeded" })),
    cancel: vi.fn(),
    watchScreen: vi.fn(async () => ({
      status: "failed",
      kind: "unavailable",
      message: "The live emulator view is not available in this test.",
    })),
    ...overrides,
  };
}

describe("AndroidEmulatorPane", () => {
  it("asks once to Allow input, then Home runs without another confirmation", async () => {
    let resolveApproval: ((id: string | undefined) => void) | undefined;
    const requestApproval = vi.fn(
      () =>
        new Promise<string | undefined>((resolve) => {
          resolveApproval = resolve;
        }),
    );
    const execute = vi.fn(async () => ({ outcome: "succeeded" }));
    render(
      <AndroidEmulatorPane
        checkoutId={ids.checkout as never}
        client={client({ execute }) as never}
        createUuid={uuidFactory()}
        hostBridge={
          {
            getHostCapabilities: () => ({
              sidebarVibrancySupported: false,
              liveSimulatorFrameSupported: true,
            }),
          } as never
        }
        requestApproval={requestApproval}
        thread={thread as never}
      />,
    );

    const home = await screen.findByRole("button", { name: "Home" });
    fireEvent.click(home);
    fireEvent.click(home);
    expect(requestApproval).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();

    const allow = await screen.findByRole("button", { name: "Allow input to Pixel 8" });
    fireEvent.click(allow);
    fireEvent.click(allow);
    await waitFor(() => expect(requestApproval).toHaveBeenCalledTimes(1));
    resolveApproval?.(ids.approval);
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ kind: "open-input" }));

    fireEvent.click(home);
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ kind: "key-press", key: "home" }),
    );
  });

  it("says the destination is unavailable when the SDK is missing", async () => {
    const { AndroidToolchainClientFailure } = await import(
      "@octant/client-runtime/android-toolchain-client"
    );
    render(
      <AndroidEmulatorPane
        checkoutId={ids.checkout as never}
        client={
          client({
            discover: vi.fn(async () => {
              throw new AndroidToolchainClientFailure(
                "sdk-not-found",
                "The Android SDK is unavailable on this host.",
              );
            }),
          }) as never
        }
        createUuid={uuidFactory()}
        thread={{ ...thread, executionPolicy: "full-access" } as never}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "Android emulator is unavailable" }),
    ).toBeVisible();
  });
});
