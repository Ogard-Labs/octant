import { expect, it, vi } from "vitest";
import type { WindowsHostProfileNative, WindowsHostProfilePaths } from "./windowsHostProfile";
import { createWindowsDesktopLauncher } from "./windowsDesktopLauncher";

const paths: WindowsHostProfilePaths = {
  platform: "win32",
  profile: "octant",
  profileId: "11111111-1111-4111-8111-111111111111",
  rootDirectory: "C:\\profile",
  dataDirectory: "C:\\profile\\data",
  configDirectory: "C:\\profile\\config",
  stateDirectory: "C:\\profile\\state",
  logsDirectory: "C:\\profile\\logs",
};
function fixture() {
  return {
    apiVersion: 1,
    frameBytes: 16384,
    openProfile: vi.fn(),
    prepare: vi.fn(),
    claim: vi.fn(),
    poll: vi.fn(),
    reply: vi.fn(),
    close: vi.fn(),
    lookup: vi.fn(),
    beginRequest: vi.fn(),
    pollRequest: vi.fn(),
    closeRequest: vi.fn(),
    desktopLauncher: vi.fn(),
  } satisfies WindowsHostProfileNative & { desktopLauncher: ReturnType<typeof vi.fn> };
}
it("uses only the admitted Stable profile for native recording and launch with mode-specific results", async () => {
  const native = fixture();
  const launcher = createWindowsDesktopLauncher(native, paths);
  if (launcher === undefined) throw Error("Expected native launcher fixture.");
  native.desktopLauncher.mockResolvedValue({ status: "recorded" });
  await expect(launcher.record()).resolves.toEqual({ status: "recorded" });
  expect(native.desktopLauncher).toHaveBeenLastCalledWith(
    "octant",
    paths.profileId,
    paths.dataDirectory,
    "record",
  );
  native.desktopLauncher.mockResolvedValue({ status: "started" });
  await expect(launcher.launch()).resolves.toEqual({ status: "started" });
  expect(native.desktopLauncher).toHaveBeenLastCalledWith(
    "octant",
    paths.profileId,
    paths.dataDirectory,
    "launch",
  );
  native.desktopLauncher.mockResolvedValue({ status: "missing" });
  await expect(launcher.launch()).resolves.toEqual({ status: "missing" });
  await expect(launcher.record()).resolves.toEqual({ status: "refused" });
});
it("refuses unavailable, malformed or failed native operations without ordinary-file fallback", async () => {
  const native = fixture();
  expect(
    createWindowsDesktopLauncher(native, { ...paths, profile: "nightly-test-data" }),
  ).toBeUndefined();
  const { desktopLauncher: _, ...legacy } = native;
  expect(createWindowsDesktopLauncher(legacy, paths)).toBeUndefined();
  const launcher = createWindowsDesktopLauncher(native, paths);
  if (launcher === undefined) throw Error("Expected native launcher fixture.");
  for (const value of [null, [], "started", { status: "recorded" }, { status: "unexpected" }]) {
    native.desktopLauncher.mockResolvedValue(value);
    await expect(launcher.launch()).resolves.toEqual({ status: "refused" });
  }
  native.desktopLauncher.mockResolvedValue({
    status: "refused",
    reason: "deadline-exceeded",
    elapsedMs: 2501,
    scannedEntries: 1000,
    privateRecord: "not returned",
  });
  await expect(launcher.record()).resolves.toEqual({
    status: "refused",
    reason: "deadline-exceeded",
    elapsedMs: 2501,
    scannedEntries: 1000,
  });
  native.desktopLauncher.mockResolvedValue({
    status: "refused",
    reason: "arbitrary text",
    elapsedMs: -1,
    scannedEntries: "1000",
  });
  await expect(launcher.launch()).resolves.toEqual({ status: "refused" });
  native.desktopLauncher.mockRejectedValue(Error("native operation failed"));
  await expect(launcher.record()).resolves.toEqual({ status: "refused" });
  await expect(launcher.launch()).resolves.toEqual({ status: "refused" });
});
