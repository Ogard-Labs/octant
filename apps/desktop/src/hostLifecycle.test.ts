import { resolveUpdateInstallReadiness } from "@octant/domain";
import { describe, expect, it, vi } from "vitest";
import {
  createHostLifecycleController,
  shouldConfirmQuit,
  workInFlight,
  type LocalHostDescriptor,
  type LocalHostSnapshot,
} from "./hostLifecycle";

const desktopHost: LocalHostDescriptor = {
  url: "http://127.0.0.1:13773/",
  instanceId: "desktop-instance",
  ownership: "desktop-owned",
};

const managedHost: LocalHostDescriptor = {
  url: "http://127.0.0.1:13773/",
  instanceId: "managed-instance",
  ownership: "managed",
};

describe("desktop host lifecycle", () => {
  it("keeps an Electron-owned host alive when the last window closes", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const lifecycle = createHostLifecycleController({
      attach: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(desktopHost),
      stop,
    });

    await lifecycle.ensureRunning();
    lifecycle.onLastWindowClosed();

    expect(lifecycle.snapshot()).toMatchObject({ state: "running", ownership: "desktop-owned" });
    expect(stop).not.toHaveBeenCalled();
  });

  it("gracefully stops an owned host on quit after confirmation for active work", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const lifecycle = createHostLifecycleController({
      attach: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(desktopHost),
      stop,
    });

    await lifecycle.ensureRunning();
    lifecycle.setActivity({ activeAgentCount: 2, attentionRequired: true });

    await expect(lifecycle.prepareQuit(() => true)).resolves.toBe("stopped");
    expect(stop).toHaveBeenCalledWith(desktopHost);
    expect(lifecycle.snapshot().state).toBe("stopped");
  });

  it("does not stop or orphan active work when quit confirmation is declined", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const lifecycle = createHostLifecycleController({
      attach: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(desktopHost),
      stop,
    });

    await lifecycle.ensureRunning();
    lifecycle.setActivity({ activeAgentCount: 1, attentionRequired: false });

    await expect(lifecycle.prepareQuit(() => false)).resolves.toBe("cancelled");
    expect(stop).not.toHaveBeenCalled();
    expect(lifecycle.snapshot().state).toBe("running");
  });

  it("attaches to a managed host and never stops it during Electron quit", async () => {
    const start = vi.fn().mockResolvedValue(desktopHost);
    const stop = vi.fn().mockResolvedValue(undefined);
    const attach = vi.fn().mockResolvedValue(managedHost);
    const lifecycle = createHostLifecycleController({ attach, start, stop });

    await expect(lifecycle.ensureRunning()).resolves.toMatchObject(managedHost);
    await expect(lifecycle.prepareQuit(() => true)).resolves.toBe("attached");

    expect(attach).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(lifecycle.snapshot()).toMatchObject({ state: "running", ownership: "managed" });
  });

  it("reattaches to a replacement managed owner after its instance changes", async () => {
    const replacementHost: LocalHostDescriptor = {
      ...managedHost,
      instanceId: "replacement-managed-instance",
    };
    const attach = vi
      .fn()
      .mockResolvedValueOnce(managedHost)
      .mockResolvedValueOnce(replacementHost);
    const lifecycle = createHostLifecycleController({
      attach,
      start: vi.fn().mockResolvedValue(desktopHost),
      stop: vi.fn().mockResolvedValue(undefined),
    });

    await lifecycle.ensureRunning();

    await expect(lifecycle.reattachManagedHost()).resolves.toEqual(replacementHost);
    expect(attach).toHaveBeenCalledTimes(2);
    expect(lifecycle.snapshot()).toMatchObject({
      state: "running",
      ownership: "managed",
      instanceId: replacementHost.instanceId,
      attentionRequired: false,
    });
  });

  it("keeps managed-host recovery fail-closed when no replacement owner is proven", async () => {
    const attach = vi.fn().mockResolvedValueOnce(managedHost).mockResolvedValueOnce(undefined);
    const lifecycle = createHostLifecycleController({
      attach,
      start: vi.fn().mockResolvedValue(desktopHost),
      stop: vi.fn().mockResolvedValue(undefined),
    });

    await lifecycle.ensureRunning();

    await expect(lifecycle.reattachManagedHost()).resolves.toBeUndefined();
    expect(lifecycle.snapshot()).toMatchObject({
      state: "attention-required",
      ownership: "managed",
      instanceId: managedHost.instanceId,
      attentionRequired: true,
    });
  });

  it("rolls back to stopped when a desktop-owned restart fails to start", async () => {
    const start = vi
      .fn()
      .mockResolvedValueOnce(desktopHost)
      .mockRejectedValueOnce(new Error("start failed"));
    const lifecycle = createHostLifecycleController({
      attach: vi.fn().mockResolvedValue(undefined),
      start,
      stop: vi.fn().mockResolvedValue(undefined),
    });

    await lifecycle.ensureRunning();
    await expect(lifecycle.restart()).rejects.toThrow("start failed");

    expect(lifecycle.snapshot()).toMatchObject({
      state: "stopped",
      ownership: undefined,
      activeAgentCount: 0,
      attentionRequired: false,
    });
  });

  it("requires confirmation only for owned active work", () => {
    expect(
      shouldConfirmQuit({
        state: "running",
        ownership: "desktop-owned",
        activeAgentCount: 1,
        attentionRequired: false,
      }),
    ).toBe(true);
    expect(
      shouldConfirmQuit({
        state: "running",
        ownership: "managed",
        activeAgentCount: 1,
        attentionRequired: true,
      }),
    ).toBe(false);
  });

  it("lets an update install and quit proceed when a provider only needs sign-in", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const lifecycle = createHostLifecycleController({
      attach: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(desktopHost),
      stop,
    });
    await lifecycle.ensureRunning();
    // What the host reports for an installed provider CLI that is not signed
    // in: nothing is running, but the menu bar still shows the provider.
    lifecycle.setActivity({ activeAgentCount: 0, attentionRequired: true });

    const snapshot = lifecycle.snapshot();
    expect(snapshot.state).toBe("attention-required");
    expect(resolveUpdateInstallReadiness(workInFlight(snapshot))).toEqual({ kind: "ready" });
    const confirm = vi.fn(() => false);
    await expect(lifecycle.prepareQuit(confirm)).resolves.toBe("stopped");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("makes an update install wait while an agent is running", () => {
    const running: LocalHostSnapshot = {
      state: "running",
      ownership: "desktop-owned",
      activeAgentCount: 1,
      attentionRequired: false,
    };
    expect(resolveUpdateInstallReadiness(workInFlight(running))).toEqual({
      kind: "wait",
      activeAgentCount: 1,
      activityUnconfirmed: false,
    });
    expect(shouldConfirmQuit(running)).toBe(true);
  });

  it("keeps waiting and confirming when the desktop could not confirm what the host is running", () => {
    const unconfirmed: LocalHostSnapshot = {
      state: "attention-required",
      ownership: "desktop-owned",
      activeAgentCount: 0,
      attentionRequired: true,
      activityUnconfirmed: true,
    };
    expect(resolveUpdateInstallReadiness(workInFlight(unconfirmed))).toEqual({
      kind: "wait",
      activeAgentCount: 0,
      activityUnconfirmed: true,
    });
    expect(shouldConfirmQuit(unconfirmed)).toBe(true);
  });

  it("refreshes activity before deciding whether an update install may proceed or must wait", async () => {
    let current: LocalHostSnapshot = {
      state: "running",
      ownership: "desktop-owned",
      activeAgentCount: 1,
      attentionRequired: false,
    };

    // Cached snapshot says busy, fresh reading says idle: install proceeds.
    await expect(
      workInFlight({
        refreshActivity: async () => {
          current = { ...current, activeAgentCount: 0 };
        },
        snapshot: () => current,
      }).then(resolveUpdateInstallReadiness),
    ).resolves.toEqual({ kind: "ready" });

    // Cached snapshot says idle, fresh reading says busy: install waits.
    await expect(
      workInFlight({
        refreshActivity: async () => {
          current = { ...current, activeAgentCount: 2 };
        },
        snapshot: () => current,
      }).then(resolveUpdateInstallReadiness),
    ).resolves.toEqual({
      kind: "wait",
      activeAgentCount: 2,
      activityUnconfirmed: false,
    });

    // Cached snapshot says idle, refresh fails: install waits on unconfirmed activity.
    current = { ...current, activeAgentCount: 0 };
    await expect(
      workInFlight({
        refreshActivity: async () => {
          throw new Error("probe failed");
        },
        snapshot: () => current,
      }).then(resolveUpdateInstallReadiness),
    ).resolves.toEqual({
      kind: "wait",
      activeAgentCount: 0,
      activityUnconfirmed: true,
    });
  });

  it("treats a managed host that cannot be re-attached as unconfirmed work", async () => {
    const attach = vi.fn().mockResolvedValueOnce(managedHost).mockResolvedValueOnce(undefined);
    const lifecycle = createHostLifecycleController({
      attach,
      start: vi.fn().mockResolvedValue(desktopHost),
      stop: vi.fn().mockResolvedValue(undefined),
    });
    await lifecycle.ensureRunning();
    await lifecycle.reattachManagedHost();

    expect(lifecycle.snapshot()).toMatchObject({ activityUnconfirmed: true });
  });
});
