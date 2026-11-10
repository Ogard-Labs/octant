import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  host: { accessibility: true, screenRecording: true },
  driver: { accessibility: false, screen_recording: false } as unknown,
  starts: 0,
  runtimeCloses: 0,
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
      close: vi.fn(async () => {
        fixture.runtimeCloses += 1;
      }),
    };
  }),
}));
import * as updateModule from "./computerUseDriverUpdates";
import * as controlModule from "./computerUseControlHost";
import { createComputerUseDesktopService } from "./computerUseDesktopService";

function service() {
  return createComputerUseDesktopService({
    bundledPath: "fixture",
    dataDirectory: "/nonexistent-octant-fixture",
    isWindowAvailable: () => true,
  });
}

describe("Computer use permission status", () => {
  beforeEach(() => {
    vi.stubGlobal("process", { ...process, platform: "darwin", arch: "arm64" });
    fixture.host = { accessibility: true, screenRecording: true };
    fixture.driver = { accessibility: true, screen_recording: true };
  });
  afterEach(() => vi.unstubAllGlobals());
  it("keeps permission grants separate from a working test and clears verification after revocation", async () => {
    const computer = service();
    await computer.configure({ enabled: true, automaticUpdates: false });
    try {
      expect((await computer.status()).verification).toBe("not-tested");
      expect((await computer.test(async () => true)).verification).toBe("passed");
      fixture.driver = { accessibility: false, screen_recording: true };
      expect((await computer.status()).verification).toBe("not-tested");
      const run = vi.fn(async () => true);
      expect((await computer.test(run)).verification).toBe("failed");
      expect(run).not.toHaveBeenCalled();
    } finally {
      await computer.close();
    }
  });
  it("cancels a test when disabled and never accepts its late success", async () => {
    const computer = service();
    await computer.configure({ enabled: true, automaticUpdates: false });
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = computer.test(async (_runtime, signal) => {
      entered?.();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return true;
    });
    await started;
    await computer.configure({ enabled: false, automaticUpdates: false });
    expect((await pending).verification).toBe("not-tested");
    await computer.close();
  });
  it("closes controls and its driver even after updater cleanup fails", async () => {
    const createUpdates = updateModule.createComputerUseDriverUpdates;
    const createControls = controlModule.createComputerUseControlHost;
    const closes: Array<ReturnType<typeof vi.fn>> = [];
    const updatesSpy = vi
      .spyOn(updateModule, "createComputerUseDriverUpdates")
      .mockImplementation((options) => {
        const updates = createUpdates(options);
        return {
          ...updates,
          close: async () => {
            await updates.close();
            throw new Error("updater failed");
          },
        };
      });
    const controlsSpy = vi
      .spyOn(controlModule, "createComputerUseControlHost")
      .mockImplementation((options) => {
        const controls = createControls(options);
        const close = vi.fn(controls.close);
        closes.push(close);
        return { ...controls, close };
      });
    const computer = service();
    const previousRuntimeCloses = fixture.runtimeCloses;
    try {
      fixture.host = { accessibility: true, screenRecording: true };
      fixture.driver = { accessibility: true, screen_recording: true };
      await computer.configure({ enabled: true, automaticUpdates: false });
      await computer.status();
      const completion = computer.close();
      await expect(completion).rejects.toThrow();
      expect(closes[0]).toHaveBeenCalledOnce();
      expect(fixture.runtimeCloses).toBe(previousRuntimeCloses + 1);
      expect(computer.close()).toBe(completion);
    } finally {
      updatesSpy.mockRestore();
      controlsSpy.mockRestore();
    }
  });

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
});
