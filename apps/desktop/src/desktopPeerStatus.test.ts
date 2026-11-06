import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  desktopPeerPreflight,
  encodeLinuxLauncherRecord,
  ensureNightlyHostReady,
  linuxRendererSandboxDisabled,
  loadDesktopPeerStatus,
  ownDesktopPeerStatus,
  writeLinuxLauncherRecord,
} from "./desktopPeerStatus";

describe("Linux client trust in desktop main", () => {
  it("treats any unsandboxed renderer switch or variable as no sandbox", () => {
    const none = { hasSwitch: () => false, argv: ["/opt/Octant Nightly"], env: {} };
    expect(linuxRendererSandboxDisabled(none)).toBe(false);
    expect(
      linuxRendererSandboxDisabled({ ...none, hasSwitch: (name) => name === "no-sandbox" }),
    ).toBe(true);
    expect(
      linuxRendererSandboxDisabled({
        ...none,
        hasSwitch: (name) => name === "disable-setuid-sandbox",
      }),
    ).toBe(true);
    expect(linuxRendererSandboxDisabled({ ...none, argv: ["x", "--no-sandbox"] })).toBe(true);
    expect(linuxRendererSandboxDisabled({ ...none, env: { ELECTRON_DISABLE_SANDBOX: "1" } })).toBe(
      true,
    );
  });

  it("never loads the Linux binding for a development build or without Octant's endpoint", () => {
    const endpoint = {
      windowsSocketPath: "/tmp/octant-1000/a.windows.v1.sock",
      launcherRecordPath: "/tmp/octant-1000/a.launcher.json",
      version: "1.0.0",
    };
    expect(
      loadDesktopPeerStatus({
        packaged: false,
        platform: "linux",
        resourcesPath: "/r",
        linux: endpoint,
      }),
    ).toBeUndefined();
    expect(
      loadDesktopPeerStatus({ packaged: true, platform: "linux", resourcesPath: "/r" }),
    ).toBeUndefined();
    expect(
      loadDesktopPeerStatus({
        packaged: true,
        platform: "win32",
        resourcesPath: "/r",
        linux: endpoint,
      }),
    ).toBeUndefined();
  });

  it("records the AppImage Octant launched from, and nothing for a non-image launch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-launcher-record-"));
    try {
      const image = join(directory, 'Octant "x".AppImage');
      await writeFile(image, "image", { mode: 0o755 });
      const record = join(directory, "a.launcher.json");
      await expect(writeLinuxLauncherRecord({ recordPath: record, appImage: image })).resolves.toBe(
        "written",
      );
      const metadata = await lstat(image, { bigint: true });
      expect(await readFile(record, "utf8")).toBe(
        encodeLinuxLauncherRecord({ appImage: image, device: metadata.dev, inode: metadata.ino }),
      );
      expect((await lstat(record)).mode & 0o777).toBe(0o600);
      expect(encodeLinuxLauncherRecord({ appImage: "/a", device: 1n, inode: 2n })).toBe(
        '{"schemaVersion":1,"appImage":"/a","device":"1","inode":"2"}\n',
      );
      const linked = join(directory, "linked.AppImage");
      await symlink(image, linked);
      const other = join(directory, "b.launcher.json");
      for (const appImage of [undefined, "relative.AppImage", linked, join(directory, "missing")])
        await expect(writeLinuxLauncherRecord({ recordPath: other, appImage })).resolves.toBe(
          "skipped",
        );
      await expect(lstat(other)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

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
