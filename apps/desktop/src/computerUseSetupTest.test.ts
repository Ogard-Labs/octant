import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({
  approve: vi.fn(),
  probe: vi.fn(),
  destroy: vi.fn(),
  closed: false,
}));
vi.mock("./computerUseProbe", () => ({ probeComputerUse: native.probe }));
vi.mock("electron", () => ({
  dialog: { showMessageBox: native.approve },
  BrowserWindow: class extends EventEmitter {
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      executeJavaScript: vi.fn(async () => true),
    };
    loadURL = vi.fn(async () => {
      this.emit("ready-to-show");
    });
    show = vi.fn();
    getMediaSourceId = () => "window:42:0";
    isDestroyed = () => native.closed;
    destroy = () => {
      native.closed = true;
      native.destroy();
    };
  },
}));
import { BrowserWindow } from "electron";
import { testComputerUseWindow } from "./computerUseSetupTest";
import type { ComputerDriverRuntime } from "./computerUseSdkRuntime";
const runtime: ComputerDriverRuntime = {
  generation: "fixture",
  version: "0.38.0",
  call: vi.fn(),
  close: vi.fn(),
};
beforeEach(() => {
  vi.clearAllMocks();
  native.closed = false;
  native.approve.mockResolvedValue({ response: 1 });
  native.probe.mockResolvedValue(undefined);
});
function parent() {
  const window = new BrowserWindow();
  window.once = vi.fn();
  window.removeListener = vi.fn();
  return window;
}
it("does not capture or click when the local confirmation is cancelled", async () => {
  native.approve.mockResolvedValue({ response: 0 });
  expect(await testComputerUseWindow(parent(), runtime, new AbortController().signal)).toBe(false);
  expect(native.probe).not.toHaveBeenCalled();
});
it("chooses its own window address and destroys it after either success or failure", async () => {
  await testComputerUseWindow(parent(), runtime, new AbortController().signal);
  expect(native.probe).toHaveBeenCalledWith(
    runtime,
    expect.objectContaining({ windowId: 42, buttonLabel: expect.stringMatching(/^Test button /) }),
    expect.any(AbortSignal),
  );
  expect(native.destroy).toHaveBeenCalledOnce();
  native.closed = false;
  native.probe.mockRejectedValue(new Error("capture failed"));
  await expect(
    testComputerUseWindow(parent(), runtime, new AbortController().signal),
  ).rejects.toThrow("capture failed");
  expect(native.destroy).toHaveBeenCalledTimes(2);
});
it("destroys the fixture immediately when cancelled during a probe", async () => {
  const abort = new AbortController();
  native.probe.mockImplementation(async () => {
    abort.abort();
    expect(native.closed).toBe(true);
    throw new Error("cancelled");
  });
  await expect(testComputerUseWindow(parent(), runtime, abort.signal)).rejects.toThrow("cancelled");
  expect(native.destroy).toHaveBeenCalledOnce();
});
