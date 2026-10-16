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

/** One picture, then silence until the view is given up, as a real stream behaves. */
async function* endsWith(signal: AbortSignal) {
  yield Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
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

  it("offers Record screen only once the host reports it, and confirms starting but not stopping", async () => {
    const userEvent = (await import("@testing-library/user-event")).default;
    const user = userEvent.setup();
    const requestApproval = vi.fn(async () => ids.approval);
    const execute = vi.fn(async () => ({ outcome: "succeeded" }));
    const snapshot = (extra: Record<string, unknown>) => ({
      sequence: 1,
      snapshotAt: "2026-10-14T20:00:03.000Z",
      sdk: discovery.sdk,
      emulators: discovery.emulators,
      active: [],
      recentEvidence: [],
      ...extra,
    });
    const props = (extra: Record<string, unknown>) => ({
      checkoutId: ids.checkout as never,
      client: client({ execute, snapshot: vi.fn(async () => snapshot(extra)) }) as never,
      createUuid: uuidFactory(),
      hostBridge: {
        getHostCapabilities: () => ({
          sidebarVibrancySupported: false,
          liveAndroidFrameSupported: true,
        }),
      } as never,
      requestApproval,
      thread: thread as never,
    });
    const openMore = async () => {
      await screen.findByRole("button", { name: "Home" });
      screen.getByRole("button", { name: "More" }).focus();
      await user.keyboard("{Enter}");
    };

    const older = render(<AndroidEmulatorPane {...props({})} />);
    await openMore();
    await screen.findAllByRole("menuitem");
    expect(screen.queryByRole("menuitem", { name: /Record screen|Stop recording/ })).toBeNull();
    older.unmount();

    const idle = render(
      <AndroidEmulatorPane {...props({ capabilities: { recordScreen: true } })} />,
    );
    await openMore();
    await user.click(await screen.findByRole("menuitem", { name: "Record screen" }));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(requestApproval).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: "start-recording" }),
    );
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "start-recording",
        approval: { kind: "approved", approvalId: ids.approval },
      }),
    );
    idle.unmount();

    render(
      <AndroidEmulatorPane
        {...props({
          capabilities: { recordScreen: true },
          recordings: [{ emulatorId: "Pixel_8_API_34", startedAt: "2026-10-14T20:00:00.000Z" }],
        })}
      />,
    );
    await openMore();
    await user.click(await screen.findByRole("menuitem", { name: "Stop recording" }));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "stop-recording" }));
  });

  it("offers Open URL only once the host reports it, and confirms each address before sending it", async () => {
    const userEvent = (await import("@testing-library/user-event")).default;
    const user = userEvent.setup();
    const requestApproval = vi.fn(async () => ids.approval);
    const execute = vi.fn(async () => ({ outcome: "succeeded" }));
    const snapshot = (capabilities?: { readonly openUrl: boolean }) => ({
      sequence: 1,
      snapshotAt: "2026-10-14T20:00:03.000Z",
      sdk: discovery.sdk,
      emulators: discovery.emulators,
      active: [],
      recentEvidence: [],
      ...(capabilities === undefined ? {} : { capabilities }),
    });
    const props = (reported: boolean) => ({
      checkoutId: ids.checkout as never,
      client: client({
        execute,
        snapshot: vi.fn(async () => snapshot(reported ? { openUrl: true } : undefined)),
      }) as never,
      createUuid: uuidFactory(),
      hostBridge: {
        getHostCapabilities: () => ({
          sidebarVibrancySupported: false,
          liveAndroidFrameSupported: true,
        }),
      } as never,
      requestApproval,
      thread: thread as never,
    });

    const older = render(<AndroidEmulatorPane {...props(false)} />);
    await screen.findByRole("button", { name: "Home" });
    screen.getByRole("button", { name: "More" }).focus();
    await user.keyboard("{Enter}");
    await screen.findAllByRole("menuitem");
    expect(screen.queryByRole("menuitem", { name: /Open URL/ })).not.toBeInTheDocument();
    older.unmount();

    render(<AndroidEmulatorPane {...props(true)} />);
    await screen.findByRole("button", { name: "Home" });
    screen.getByRole("button", { name: "More" }).focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("menuitem", { name: "Open URL…" }));
    await user.type(
      await screen.findByRole("textbox", { name: "Address to open on Pixel 8" }),
      "https://example.com/welcome",
    );
    await user.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(requestApproval).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: "open-url", url: "https://example.com/welcome" }),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "open-url",
        url: "https://example.com/welcome",
        approval: { kind: "approved", approvalId: ids.approval },
      }),
    );
  });

  it("offers Rotate only once the host reports it, and confirms it before sending", async () => {
    const userEvent = (await import("@testing-library/user-event")).default;
    const user = userEvent.setup();
    const requestApproval = vi.fn(async () => ids.approval);
    const execute = vi.fn(async () => ({ outcome: "succeeded" }));
    const snapshot = (reported: boolean) => ({
      sequence: 1,
      snapshotAt: "2026-10-14T20:00:03.000Z",
      sdk: discovery.sdk,
      emulators: discovery.emulators,
      active: [],
      recentEvidence: [],
      ...(reported ? { capabilities: { rotate: true } } : {}),
    });
    const props = (reported: boolean) => ({
      checkoutId: ids.checkout as never,
      client: client({
        execute,
        snapshot: vi.fn(async () => snapshot(reported)),
      }) as never,
      createUuid: uuidFactory(),
      hostBridge: {
        getHostCapabilities: () => ({
          sidebarVibrancySupported: false,
          liveAndroidFrameSupported: true,
        }),
      } as never,
      requestApproval,
      thread: thread as never,
    });

    const older = render(<AndroidEmulatorPane {...props(false)} />);
    await screen.findByRole("button", { name: "Home" });
    screen.getByRole("button", { name: "More" }).focus();
    await user.keyboard("{Enter}");
    await screen.findAllByRole("menuitem");
    expect(screen.queryByRole("menuitem", { name: "Rotate" })).not.toBeInTheDocument();
    older.unmount();

    render(<AndroidEmulatorPane {...props(true)} />);
    await screen.findByRole("button", { name: "Home" });
    screen.getByRole("button", { name: "More" }).focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("menuitem", { name: "Rotate" }));

    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(requestApproval).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: "rotate", orientation: "landscape" }),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "rotate",
        orientation: "landscape",
        approval: { kind: "approved", approvalId: ids.approval },
      }),
    );
  });

  it("keeps showing an emulator the person chose to boot while several others run", async () => {
    const sdk = discovery.sdk;
    let emulators = [
      {
        emulatorId: "A" as never,
        name: "Pixel A",
        state: "booted" as const,
        serial: "emulator-5554",
      },
      {
        emulatorId: "B" as never,
        name: "Pixel B",
        state: "booted" as const,
        serial: "emulator-5556",
      },
      { emulatorId: "C" as never, name: "Pixel C", state: "shutdown" as const },
    ];
    const execute = vi.fn(async () => {
      emulators = emulators.map((one) =>
        one.emulatorId === ("C" as never) ? { ...one, state: "booting" as const } : one,
      ) as typeof emulators;
      return { outcome: "succeeded" };
    });
    const snapshot = vi.fn(async () => ({
      sequence: 1,
      snapshotAt: "2026-09-20T20:00:03.000Z",
      sdk,
      emulators,
      active: [],
      recentEvidence: [],
    }));
    render(
      <AndroidEmulatorPane
        checkoutId={ids.checkout as never}
        client={
          client({ discover: vi.fn(async () => ({ sdk, emulators })), snapshot, execute }) as never
        }
        createUuid={uuidFactory()}
        thread={{ ...thread, executionPolicy: "full-access" } as never}
      />,
    );

    fireEvent.click(await screen.findByRole("radio", { name: /Pixel C/ }));
    fireEvent.click(screen.getByRole("button", { name: "Boot Pixel C" }));
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({ kind: "boot" })),
    );
    await waitFor(() =>
      expect(screen.queryByRole("radio", { name: /Pixel C/ })).not.toBeInTheDocument(),
    );
    expect(screen.getAllByText(/Pixel C/).length).toBeGreaterThan(0);
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
  it("moves from snapshots to the live stream by itself after a slow first attach", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 1080, height: 2400, close: () => undefined })),
    );
    const watching = (transport: unknown, signal: AbortSignal) => ({
      status: "watching",
      screen: { width: 1080, height: 2400 },
      frames: endsWith(signal),
      transport,
    });
    const watchScreen = vi
      .fn()
      .mockImplementationOnce(async (_request: unknown, signal: AbortSignal) =>
        watching({ kind: "screencap", reason: "timed-out" }, signal),
      )
      .mockImplementation(async (_request: unknown, signal: AbortSignal) =>
        watching({ kind: "stream" }, signal),
      );
    try {
      render(
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
        />,
      );
      expect(
        await screen.findByText(
          "Snapshots, live stream unavailable: serve-avd did not attach in time.",
        ),
      ).toBeVisible();
      await vi.advanceTimersByTimeAsync(4_500);
      expect(await screen.findByText("Live stream")).toBeVisible();
      expect(watchScreen).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("gives a later slow attach its retries again after the stream has been live", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 1080, height: 2400, close: () => undefined })),
    );
    const slow = { kind: "screencap", reason: "timed-out" };
    async function* livePicture() {
      yield Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
    }
    const view = (transport: unknown, signal: AbortSignal, ends: boolean) => ({
      status: "watching",
      screen: { width: 1080, height: 2400 },
      frames: ends ? livePicture() : endsWith(signal),
      transport,
    });
    // Two slow attaches use the budget, the third reaches the stream and then
    // drops, and the next attach is slow again.
    const watchScreen = vi
      .fn()
      .mockImplementationOnce(async (_r: unknown, signal: AbortSignal) => view(slow, signal, false))
      .mockImplementationOnce(async (_r: unknown, signal: AbortSignal) => view(slow, signal, false))
      .mockImplementationOnce(async (_r: unknown, signal: AbortSignal) =>
        view({ kind: "stream" }, signal, true),
      )
      .mockImplementationOnce(async (_r: unknown, signal: AbortSignal) => view(slow, signal, false))
      .mockImplementation(async (_r: unknown, signal: AbortSignal) =>
        view({ kind: "stream" }, signal, false),
      );
    try {
      render(
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
        />,
      );
      await screen.findByText(/Snapshots, live stream unavailable/);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await screen.findByText("Live stream")).toBeVisible();
      // Attach 4 was slow and still got its retry (attach 5).
      expect(watchScreen.mock.calls.length).toBeGreaterThanOrEqual(5);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("stops asking for the stream after two retries when it never attaches in time", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 1080, height: 2400, close: () => undefined })),
    );
    const watchScreen = vi.fn(async (_request: unknown, signal: AbortSignal) => ({
      status: "watching",
      screen: { width: 1080, height: 2400 },
      frames: endsWith(signal),
      transport: { kind: "screencap", reason: "no-frames" },
    }));
    try {
      render(
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
        />,
      );
      await screen.findByText(/Snapshots, live stream unavailable/);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(watchScreen).toHaveBeenCalledTimes(3);
      expect(screen.getByText(/Snapshots, live stream unavailable/)).toBeVisible();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
  describe("Shut down from the More menu", () => {
    async function shutDown(options: {
      readonly requestApproval: () => Promise<string | undefined>;
      readonly execute: () => Promise<unknown>;
    }) {
      const userEvent = (await import("@testing-library/user-event")).default;
      const user = userEvent.setup();
      const execute = vi.fn(options.execute);
      const requestApproval = vi.fn(options.requestApproval);
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
      await screen.findByRole("button", { name: "Home" });
      screen.getByRole("button", { name: "More" }).focus();
      await user.keyboard("{Enter}");
      await user.click(await screen.findByRole("menuitem", { name: "Shut down Pixel 8" }));
      return { execute, requestApproval };
    }

    it("asks through the approval surface first, then shuts down with that approval", async () => {
      const { execute, requestApproval } = await shutDown({
        requestApproval: async () => ids.approval,
        execute: async () => ({ outcome: "succeeded" }),
      });
      await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
      expect(requestApproval).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ kind: "shutdown" }),
      );
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "shutdown",
          approval: { kind: "approved", approvalId: ids.approval },
        }),
      );
    });

    it("says Shutting down until the emulator has stopped, with no lost live view in between", async () => {
      vi.stubGlobal(
        "createImageBitmap",
        vi.fn(async () => ({ width: 1080, height: 2400, close: () => undefined })),
      );
      const userEvent = (await import("@testing-library/user-event")).default;
      const user = userEvent.setup();
      let stopped = false;
      let finish: (evidence: unknown) => void = () => undefined;
      const execute = vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const state = () => ({ ...discovery.emulators[0], state: stopped ? "shutdown" : "booted" });
      try {
        render(
          <AndroidEmulatorPane
            checkoutId={ids.checkout as never}
            client={
              client({
                execute,
                discover: vi.fn(async () => ({ ...discovery, emulators: [state()] })),
                snapshot: vi.fn(async () => ({
                  sequence: 1,
                  snapshotAt: "2026-10-16T20:00:03.000Z",
                  sdk: discovery.sdk,
                  emulators: [state()],
                  active: [],
                  recentEvidence: [],
                })),
                watchScreen: vi.fn(async () => ({
                  status: "watching",
                  screen: { width: 1080, height: 2400 },
                  frames: (async function* () {
                    yield Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
                    await new Promise(() => undefined);
                  })(),
                  transport: { kind: "stream" },
                })),
              }) as never
            }
            createUuid={uuidFactory()}
            hostBridge={
              {
                getHostCapabilities: () => ({
                  sidebarVibrancySupported: false,
                  liveAndroidFrameSupported: true,
                }),
              } as never
            }
            requestApproval={async () => ids.approval}
            thread={thread as never}
          />,
        );
        expect(await screen.findByText("Live stream")).toBeVisible();
        screen.getByRole("button", { name: "More" }).focus();
        await user.keyboard("{Enter}");
        await user.click(await screen.findByRole("menuitem", { name: "Shut down Pixel 8" }));
        // The host has accepted the power-off, but the emulator is still running.
        expect(await screen.findByText(/Shutting down Pixel 8/)).toBeVisible();
        expect(screen.queryByText("Live view lost")).toBeNull();
        expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
        stopped = true;
        finish({ outcome: "succeeded" });
        expect(await screen.findByText("No device running")).toBeVisible();
        expect(screen.queryByText("Live view lost")).toBeNull();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("runs nothing and says so when the person declines or the approval lapses", async () => {
      const { execute, requestApproval } = await shutDown({
        requestApproval: async () => undefined,
        execute: async () => ({ outcome: "succeeded" }),
      });
      expect(await screen.findByText("Nothing ran, because it wasn't approved.")).toBeVisible();
      expect(requestApproval).toHaveBeenCalledTimes(1);
      expect(execute).not.toHaveBeenCalled();
    });

    it("names the outcome when the emulator did not power off in time", async () => {
      await shutDown({
        requestApproval: async () => ids.approval,
        execute: async () => ({ outcome: "timed-out" }),
      });
      expect(await screen.findByText("Pixel 8 didn't shut down in time.")).toBeVisible();
    });

    it("says the action is waiting for confirmation instead of going quiet while the card is open", async () => {
      await shutDown({
        requestApproval: () => new Promise<string | undefined>(() => undefined),
        execute: async () => ({ outcome: "succeeded" }),
      });
      expect(
        await screen.findByText("Waiting for your approval to shut down the emulator."),
      ).toBeVisible();
    });
  });
});
