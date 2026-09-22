import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  callTool: vi.fn(),
  stop: vi.fn(async () => {}),
  destroyClient: vi.fn(),
  destroyHost: vi.fn(),
}));
vi.mock("./computerUseDriverRelease", () => ({
  verifyComputerDriverBinary: vi.fn(async () => {}),
}));
vi.mock("@trycua/cua-driver", () => ({
  EmbeddedPermissionMode: { Standard: "standard" },
  EmbeddedDriverHostOptions: { create: (options: unknown) => options },
  EmbeddedCuaDriverHost: {
    withOptions: () => ({
      start: async () => ({
        driverVersion: "0.26.0",
        contractVersion: "0.8.0",
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
import { startComputerDriverRuntime } from "./computerUseSdkRuntime";

let root: string;
beforeEach(async () => {
  vi.clearAllMocks();
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
    driver: { path: "fixture", version: "0.26.0" },
    profileDirectory: root,
    onExit: () => {},
  });
}
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
