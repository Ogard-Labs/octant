import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  callTool: vi.fn(),
  stop: vi.fn(async () => {}),
  destroyClient: vi.fn(),
  destroyHost: vi.fn(),
  requestPermissions: vi.fn(),
  currentPermissions: vi.fn(),
  openPermissionSettings: vi.fn(async () => {}),
  contractVersion: "0.8.0",
  driverVersion: "0.38.0",
}));
vi.mock("./computerUseDriverRelease", () => ({
  verifyComputerDriverBinary: vi.fn(async () => {}),
}));
vi.mock("@trycua/cua-driver", () => ({
  requestMacOsPermissions: native.requestPermissions,
  currentMacOsPermissionStatus: native.currentPermissions,
  EmbeddedPermissionMode: { Standard: "standard" },
  EmbeddedDriverHostOptions: { create: (options: unknown) => options },
  EmbeddedCuaDriverHost: {
    withOptions: () => ({
      start: async () => ({
        driverVersion: native.driverVersion,
        contractVersion: native.contractVersion,
        generation: "fixture",
        socketPath: "fixture",
      }),
      waitForExit: () => new Promise(() => {}),
      stop: native.stop,
      uniffiDestroy: native.destroyHost,
    }),
  },
  CuaDriver: {
    connect: () => ({ callTool: native.callTool, uniffiDestroy: native.destroyClient }),
  },
}));
vi.mock("@trycua/cua-driver/electron", () => ({
  openMacOSScreenRecordingSettings: native.openPermissionSettings,
}));
import { computerUsePermissions, startComputerDriverRuntime } from "./computerUseSdkRuntime";

let root: string;
beforeEach(async () => {
  vi.clearAllMocks();
  native.contractVersion = "0.8.0";
  root = await mkdtemp(join(tmpdir(), "octant-runtime-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function health(status: string) {
  return {
    isError: false,
    structuredJson: JSON.stringify({
      schema_version: "1",
      checks: [{ name: "bundle_identity", status }],
    }),
  };
}
function start() {
  return startComputerDriverRuntime({
    driver: { path: "fixture", version: "0.38.0" },
    profileDirectory: root,
    onExit: () => {},
  });
}
describe("Embedded computer runtime contract", () => {
  it("admits a driver whose contract differs only by patch", async () => {
    native.contractVersion = "0.8.7";
    native.callTool.mockResolvedValue(health("pass"));
    const runtime = await start();
    await runtime.close();
  });
  it.each(["0.9.0", "0.7.9", "1.8.0", "0.8"])(
    "refuses a driver speaking contract %s and closes native resources",
    async (contract) => {
      native.contractVersion = contract;
      await expect(start()).rejects.toThrow(/contract is incompatible/);
      expect(native.callTool).not.toHaveBeenCalled();
      expect(native.stop).toHaveBeenCalledOnce();
      expect(native.destroyHost).toHaveBeenCalledOnce();
    },
  );
});
describe("Embedded computer runtime identity", () => {
  it("refuses a driver attached to a different host application and closes native resources", async () => {
    native.callTool.mockResolvedValue(health("fail"));
    await expect(start()).rejects.toThrow(/host application identity/);
    expect(native.stop).toHaveBeenCalledOnce();
    expect(native.destroyClient).toHaveBeenCalledOnce();
    expect(native.destroyHost).toHaveBeenCalledOnce();
  });
  it("admits the runtime only after the driver verifies its host application", async () => {
    native.callTool.mockResolvedValue(health("pass"));
    const runtime = await start();
    try {
      expect(native.callTool).toHaveBeenCalledWith(
        "health_report",
        JSON.stringify({ include: ["bundle_identity"] }),
        expect.anything(),
      );
    } finally {
      await runtime.close();
    }
  });
  it("refuses an absent identity check instead of inferring trust from successful startup", async () => {
    native.callTool.mockResolvedValue({
      isError: false,
      structuredJson: JSON.stringify({ schema_version: "1", checks: [] }),
    });
    await expect(start()).rejects.toThrow(/host application identity/);
    expect(native.stop).toHaveBeenCalledOnce();
  });
});

describe.skipIf(process.platform !== "darwin")("Computer permission setup", () => {
  it("opens System Settings when a permission request leaves Screen Recording unavailable", async () => {
    const denied = { accessibility: true, screenRecording: false };
    native.requestPermissions.mockReturnValue(denied);

    expect(await computerUsePermissions(true)).toEqual(denied);
    expect(native.openPermissionSettings).toHaveBeenCalledOnce();
    expect(native.callTool).not.toHaveBeenCalled();
  });

  it("rechecks missing permissions without requesting access or opening System Settings", async () => {
    const denied = { accessibility: false, screenRecording: false };
    native.currentPermissions.mockReturnValue(denied);

    expect(await computerUsePermissions()).toEqual(denied);
    expect(native.requestPermissions).not.toHaveBeenCalled();
    expect(native.openPermissionSettings).not.toHaveBeenCalled();
  });

  it("leaves System Settings closed when the request reports Screen Recording allowed", async () => {
    const allowed = { accessibility: true, screenRecording: true };
    native.requestPermissions.mockReturnValue(allowed);

    expect(await computerUsePermissions(true)).toEqual(allowed);
    expect(native.openPermissionSettings).not.toHaveBeenCalled();
  });
});
