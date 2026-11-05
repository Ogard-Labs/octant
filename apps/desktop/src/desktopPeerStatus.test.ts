import { describe, expect, it, vi } from "vitest";
import {
  desktopPeerPreflight,
  ensureNightlyHostReady,
  ownDesktopPeerStatus,
} from "./desktopPeerStatus";

describe("the packaged desktop status preflight", () => {
  it("refuses an unknown native receipt rather than treating it as a compatible host", async () => {
    expect(
      await desktopPeerPreflight({ status: async () => ({ kind: "ready", protocol: 99 }) }),
    ).toEqual({
      kind: "refused",
      reason: "invalid-receipt",
    });
  });

  it("preserves the native refusal instead of inventing a compatible host", async () => {
    expect(
      await desktopPeerPreflight({
        status: async () => ({ kind: "refused", reason: "unsigned-build" }),
      }),
    ).toEqual({
      kind: "refused",
      reason: "unsigned-build",
    });
  });

  it("awaits a pending acquisition and releases the endpoint once after quit", async () => {
    let acquired: ((value: unknown) => void) | undefined;
    const close = vi.fn(async () => ({ kind: "closed" }));
    const owner = ownDesktopPeerStatus({
      start: () =>
        new Promise((resolve) => {
          acquired = resolve;
        }),
      close,
    });
    const first = owner.close();
    const second = owner.close();
    expect(close).not.toHaveBeenCalled();
    acquired?.({ kind: "started" });
    expect(await first).toEqual({ kind: "closed" });
    expect(await second).toEqual({ kind: "closed" });
    expect(close).toHaveBeenCalledTimes(1);
  });
});

it("launches a closed Stable once and authenticates it before opening the actual Nightly client", async () => {
  const { desktopIdentity } = await import("@octant/host-runtime");
  const { launchDesktopApplication } = await import("./desktopLaunch");
  const ready = { kind: "ready", protocol: 1, version: "0.1.0" };
  const native = {
    status: vi
      .fn()
      .mockResolvedValueOnce({ kind: "refused", reason: "not-running" })
      .mockResolvedValue(ready),
    launchStableHost: vi.fn(async () => ({ kind: "started" })),
  };
  const loadHost = vi.fn(async () => undefined);
  const openClient = vi.fn(async () => ({ kind: "started" as const }));
  expect(
    await launchDesktopApplication(
      desktopIdentity("nightly"),
      loadHost,
      () => ensureNightlyHostReady(native),
      openClient,
    ),
  ).toEqual({ kind: "started" });
  expect(native.launchStableHost).toHaveBeenCalledOnce();
  expect(native.status).toHaveBeenCalledTimes(2);
  expect(openClient).toHaveBeenCalledOnce();
  expect(loadHost).not.toHaveBeenCalled();
});

it.each([
  "unsigned-build",
  "invalid-peer",
  "invalid-scope",
  "deadline-exceeded",
  "invalid-receipt",
  "incompatible-host",
])("never launches a replacement after ambiguous or invalid status %s", async (reason) => {
  const native = {
    status: vi.fn(async () => ({ kind: "refused", reason })),
    launchStableHost: vi.fn(async () => ({ kind: "started" })),
  };
  expect(await ensureNightlyHostReady(native)).toEqual({ kind: "refused", reason });
  expect(native.launchStableHost).not.toHaveBeenCalled();
});

it("does not attach from a launch receipt without a fresh authenticated status", async () => {
  const native = {
    status: vi
      .fn()
      .mockResolvedValueOnce({ kind: "refused", reason: "not-running" })
      .mockResolvedValue({ kind: "ready", protocol: 99, version: "0.1.0" }),
    launchStableHost: vi.fn(async () => ({ kind: "started" })),
  };
  expect(await ensureNightlyHostReady(native)).toEqual({
    kind: "refused",
    reason: "invalid-receipt",
  });
});

it("bounds a missing host after one launch without retrying the launch", async () => {
  vi.useFakeTimers();
  try {
    const native = {
      status: vi.fn(async () => ({ kind: "refused", reason: "not-running" })),
      launchStableHost: vi.fn(async () => ({ kind: "started" })),
    };
    const pending = ensureNightlyHostReady(native);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(await pending).toEqual({ kind: "refused", reason: "deadline-exceeded" });
    expect(native.launchStableHost).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it("uses a running authenticated host without launching another app", async () => {
  const ready = { kind: "ready", protocol: 1, version: "0.1.0" };
  const native = {
    status: vi.fn(async () => ready),
    launchStableHost: vi.fn(async () => ({ kind: "started" })),
  };
  expect(await ensureNightlyHostReady(native)).toEqual(ready);
  expect(native.launchStableHost).not.toHaveBeenCalled();
});

it("preserves an installed-app launch refusal instead of retrying or attaching", async () => {
  const native = {
    status: vi.fn(async () => ({ kind: "refused", reason: "not-running" })),
    launchStableHost: vi.fn(async () => ({ kind: "refused", reason: "incompatible-host" })),
  };
  expect(await ensureNightlyHostReady(native)).toEqual({
    kind: "refused",
    reason: "incompatible-host",
  });
  expect(native.launchStableHost).toHaveBeenCalledOnce();
  expect(native.status).toHaveBeenCalledOnce();
});
