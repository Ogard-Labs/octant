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
  it("asks once to allow input, then Home runs without another confirmation", async () => {
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
              liveAndroidFrameSupported: true,
            }),
          } as never
        }
        requestApproval={requestApproval}
        thread={thread as never}
      />,
    );

    const home = await screen.findByRole("button", { name: "Home" });
    // Without a grant the device's buttons send nothing and say so.
    expect(home).toBeDisabled();
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(requestApproval).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();

    expect(screen.getByRole("status")).toHaveTextContent("Allow input on Pixel 8?");
    const allow = screen.getByRole("button", { name: "Allow" });
    fireEvent.click(allow);
    fireEvent.click(allow);
    await waitFor(() => expect(requestApproval).toHaveBeenCalledTimes(1));
    resolveApproval?.(ids.approval);
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ kind: "open-input" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Home" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ kind: "key-press", key: "home" }),
    );
  });

  it("lists the Android SDK as the missing setup step when the SDK is missing", async () => {
    const { AndroidToolchainClientFailure } =
      await import("@octant/client-runtime/android-toolchain-client");
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
      await screen.findByRole("heading", { name: "Set up the Android emulator" }),
    ).toBeVisible();
    expect(
      screen.getByText("Install platform-tools and the emulator with the Android SDK Manager."),
    ).toBeVisible();
  });

  it("says plainly whether the frame is the live stream or snapshots, and why", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 1080, height: 2400, close: () => undefined })),
    );
    const watching = (transport: unknown) =>
      vi.fn(async () => ({
        status: "watching",
        screen: { width: 1080, height: 2400 },
        frames: (async function* () {
          yield Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
          await new Promise(() => undefined);
        })(),
        transport,
      }));
    const pane = (watchScreen: ReturnType<typeof watching>) => (
      <AndroidEmulatorPane
        checkoutId={ids.checkout as never}
        client={client({ watchScreen }) as never}
        createUuid={uuidFactory()}
        hostBridge={
          {
            getHostCapabilities: () => ({
              sidebarVibrancySupported: false,
              liveAndroidFrameSupported: true,
            }),
          } as never
        }
        thread={thread as never}
      />
    );
    try {
      const { unmount } = render(pane(watching({ kind: "stream" })));
      expect(await screen.findByText("Live stream")).toBeVisible();
      unmount();
      render(pane(watching({ kind: "screencap", reason: "tool-exited" })));
      expect(
        await screen.findByText(
          "Snapshots, live stream unavailable: serve-avd stopped before it attached.",
        ),
      ).toBeVisible();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
