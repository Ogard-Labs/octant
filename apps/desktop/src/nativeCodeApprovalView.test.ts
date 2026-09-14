import { describe, expect, it, vi } from "vitest";
import { WebContentsView } from "electron";
import { createNativeCodeApprovalViewHost } from "./nativeCodeApprovalView";

vi.mock("electron", () => ({
  WebContentsView: class {
    readonly listeners = new Map<string, () => void>();
    webContents = {
      id: 71,
      setWindowOpenHandler: vi.fn(),
      on: (name: string, listener: () => void) => this.listeners.set(name, listener),
      loadURL: vi.fn(async () => undefined),
      send: vi.fn(),
      isDestroyed: () => this.destroyed,
      close: () => {
        this.destroyed = true;
        Object.defineProperty(this, "webContents", { value: undefined });
        this.listeners.get("destroyed")?.();
      },
    };
    destroyed = false;
    setBounds = vi.fn();
    setVisible = vi.fn();
  },
}));

describe("native Code approval views", () => {
  it("attaches the native view to the window instead of its controller port", () => {
    const host = createNativeCodeApprovalViewHost("/fixture/preload.js", vi.fn());
    const port = host.createView("fixture-token");
    const addChildView = vi.fn((view) => expect(view).toBeInstanceOf(WebContentsView));
    const removeChildView = vi.fn();
    const window = { contentView: { addChildView, removeChildView } };
    host.attach(window, port);
    host.detach(window, port);
    expect(removeChildView).toHaveBeenCalledWith(addChildView.mock.calls[0]?.[0]);
  });

  it("retains the destroyed view identity after Electron clears its web contents", () => {
    const onDestroyed = vi.fn();
    const host = createNativeCodeApprovalViewHost("/fixture/preload.js", onDestroyed);
    const port = host.createView("fixture-token");
    expect(() => port.webContents.close()).not.toThrow();
    expect(onDestroyed).toHaveBeenCalledExactlyOnceWith(71);
    expect(port.webContents.id).toBe(71);
    expect(port.webContents.isDestroyed()).toBe(true);
  });
});
