import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  host: { accessibility: true, screenRecording: true },
  driver: { accessibility: false, screen_recording: false } as unknown,
  starts: 0,
}));
vi.mock("./computerUseDriverRelease", () => ({
  BUNDLED_CUA_DRIVER: { version: "0.38.0" },
  commitComputerDriver: vi.fn(async () => {}),
  latestComputerDriverRelease: vi.fn(async () => undefined),
  readInstalledComputerDriver: vi.fn(async () => undefined),
  stageComputerDriver: vi.fn(),
  verifyComputerDriverBinary: vi.fn(async () => {}),
}));
vi.mock("./computerUseSdkRuntime", async (actual) => ({
  ...(await actual<typeof import("./computerUseSdkRuntime")>()),
  computerUsePermissions: vi.fn(async () => fixture.host),
  openComputerUsePermissionSettings: vi.fn(async () => {}),
  startComputerDriverRuntime: vi.fn(async () => {
    fixture.starts += 1;
    return {
      generation: "fixture",
      version: "0.38.0",
      call: async (name: string) =>
        name === "check_permissions"
          ? { isError: false, structuredJson: JSON.stringify(fixture.driver) }
          : { isError: true },
      close: async () => {},
    };
  }),
}));
import { createComputerUseDesktopService } from "./computerUseDesktopService";

function service() {
  return createComputerUseDesktopService({
    bundledPath: "fixture",
    dataDirectory: "/nonexistent-octant-fixture",
    isWindowAvailable: () => true,
  });
}

describe.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
  "Computer use permission status",
  () => {
    it("reports the acting driver's refusal even when macOS allows Octant itself", async () => {
      fixture.host = { accessibility: true, screenRecording: true };
      fixture.driver = { accessibility: false, screen_recording: false };
      const computer = service();
      await computer.configure({ enabled: true, automaticUpdates: false });
      try {
        const status = await computer.status();
        expect(status.permissions).toEqual({ accessibility: false, screenRecording: false });
        expect(status.message).toMatch(/driver/);
      } finally {
        await computer.close();
      }
    });

    it("reports Allowed only when both Octant and its driver hold the permissions", async () => {
      fixture.host = { accessibility: true, screenRecording: true };
      fixture.driver = { accessibility: true, screen_recording: true };
      const computer = service();
      await computer.configure({ enabled: true, automaticUpdates: false });
      try {
        expect((await computer.status()).permissions).toEqual({
          accessibility: true,
          screenRecording: true,
        });
      } finally {
        await computer.close();
      }
    });

    it("treats an unreadable driver answer as refused", async () => {
      fixture.host = { accessibility: true, screenRecording: true };
      fixture.driver = { accessibility: "yes" };
      const computer = service();
      await computer.configure({ enabled: true, automaticUpdates: false });
      try {
        expect((await computer.status()).permissions).toEqual({
          accessibility: false,
          screenRecording: false,
        });
      } finally {
        await computer.close();
      }
    });

    it("does not start the driver while Octant itself lacks a permission", async () => {
      fixture.host = { accessibility: false, screenRecording: true };
      fixture.starts = 0;
      const computer = service();
      await computer.configure({ enabled: true, automaticUpdates: false });
      try {
        expect((await computer.status()).permissions.accessibility).toBe(false);
        expect(fixture.starts).toBe(0);
      } finally {
        await computer.close();
      }
    });
  },
);
