import { EventEmitter } from "node:events";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { createNightlyInstallation } from "./nightlyInstallation";
import {
  closeNightlyInstallationForQuit,
  registerNightlyInstallationIpc,
} from "./nightlyInstallationIpc";
import { DESKTOP_IPC_CHANNELS as C } from "./ipcChannels";

function fixture() {
  const native = {
    inspect: vi.fn(
      async () => ({ kind: "installed", version: "0.1.0-preview.1", running: false }) as const,
    ),
    prepareInstall: vi.fn(async () => ({ kind: "prepared" }) as const),
    commitInstall: vi.fn(async () => ({ kind: "refused", reason: "invalid-artifact" }) as const),
    open: vi.fn(async () => ({ kind: "opened" }) as const),
    remove: vi.fn(async () => ({ kind: "removed" }) as const),
    cancel: vi.fn(async () => ({ kind: "cancelled" }) as const),
    close: vi.fn<
      () => Promise<{ kind: "closed" } | { kind: "failed"; reason: "deadline-exceeded" }>
    >(async () => ({ kind: "closed" })),
  };
  const installation = createNightlyInstallation({
    native,
    app: { packaged: true, platform: "darwin", arch: "arm64", version: "0.1.0" },
    feedBaseUrl: "https://updates.example.test",
  });
  const window = Object.assign(new EventEmitter(), { isDestroyed: () => false }) as BrowserWindow;
  const event = {} as IpcMainInvokeEvent;
  const resolveWindow = vi.fn(() => window);
  const confirmRemoval = vi.fn(async () => false);
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, ...args: ReadonlyArray<unknown>) => unknown
  >();
  const create = vi.fn(() => installation);
  registerNightlyInstallationIpc({
    handle: (channel, fn) => {
      handlers.set(channel, fn);
    },
    installation: create,
    resolveWindow,
    confirmRemoval,
  });
  const invoke = async (channel: string, ...args: ReadonlyArray<unknown>) => {
    const handler = handlers.get(channel);
    if (handler === undefined) throw new Error("Missing fixture channel.");
    return handler(event, ...args);
  };
  return { native, installation, window, resolveWindow, confirmRemoval, create, invoke };
}
describe("manual Nightly installation IPC", () => {
  it("refuses an unknown window and renderer-supplied targets before creating an operation", async () => {
    const f = fixture();
    f.resolveWindow.mockImplementation(() => {
      throw new Error("unowned");
    });
    await expect(f.invoke(C.nightlyInstallationState)).rejects.toThrow("unowned");
    expect(f.create).not.toHaveBeenCalled();
    await expect(f.invoke(C.nightlyInstallationInstall, "/tmp/other.app")).rejects.toThrow(
      "no arguments",
    );
    expect(f.native.prepareInstall).not.toHaveBeenCalled();
  });
  it("asks on the actual owned window and honours a person declining removal", async () => {
    const f = fixture();
    await f.installation.refresh();
    await f.invoke(C.nightlyInstallationRemove);
    expect(f.confirmRemoval).toHaveBeenCalledWith(f.window);
    expect(f.native.remove).not.toHaveBeenCalled();
    f.confirmRemoval.mockResolvedValue(true);
    await f.invoke(C.nightlyInstallationRemove);
    expect(f.native.remove).toHaveBeenCalledTimes(1);
    expect(f.window.listenerCount("closed")).toBe(0);
  });
  it("refuses removal when the owned window retires during confirmation", async () => {
    const f = fixture();
    await f.installation.refresh();
    const confirmation = Promise.withResolvers<boolean>();
    f.confirmRemoval.mockReturnValue(confirmation.promise);
    const request = f.invoke(C.nightlyInstallationRemove);
    f.resolveWindow.mockImplementation(() => {
      throw new Error("retired");
    });
    confirmation.resolve(true);
    await request;
    expect(f.native.remove).not.toHaveBeenCalled();
  });
  it("still shuts down the host after installer cleanup fails and does not report a completed quit", async () => {
    const f = fixture();
    f.native.close.mockResolvedValue({ kind: "failed", reason: "deadline-exceeded" });
    const shutdown = vi.fn(async () => undefined);
    await expect(closeNightlyInstallationForQuit(f.installation, shutdown)).rejects.toThrow(
      "deadline-exceeded",
    );
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
  it("waits for installer cleanup before the existing accepted host shutdown", async () => {
    const f = fixture();
    const completion = Promise.withResolvers<{ kind: "closed" }>();
    f.native.close.mockReturnValue(completion.promise);
    const shutdown = vi.fn(async () => undefined);
    const closing = closeNightlyInstallationForQuit(f.installation, shutdown);
    await Promise.resolve();
    expect(shutdown).not.toHaveBeenCalled();
    completion.resolve({ kind: "closed" });
    await closing;
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
