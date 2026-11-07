import { beforeEach, expect, it, vi } from "vitest";
import { createOffscreenBrowserSurface } from "./offscreenBrowserSurface";

const native = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("electron", () => ({
  BrowserWindow: class {
    readonly webContents = { sendInputEvent: native.send, isDestroyed: () => false };
    isDestroyed() {
      return false;
    }
    destroy() {}
  },
}));
vi.mock("./browserTextInput", () => ({ ownBrowserTextInput: () => ({ close() {} }) }));

beforeEach(() => native.send.mockReset());
const open = () =>
  createOffscreenBrowserSurface({
    owner: { windowId: "window-a", threadId: "thread-a" },
    partition: "fixture-direction-keys",
    webPreferences: {
      allowRunningInsecureContent: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

it("delivers DOM directional presses and their matching releases as native arrow keys", () => {
  const surface = open();
  try {
    for (const keyCode of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
      surface.human?.input({ type: "keyDown", keyCode, modifiers: ["shift"] });
      surface.human?.input({ type: "keyUp", keyCode, modifiers: [] });
    }
    expect(native.send.mock.calls.map(([event]) => event)).toEqual(
      ["Left", "Right", "Up", "Down"].flatMap((keyCode) => [
        { type: "keyDown", keyCode, modifiers: ["shift"] },
        { type: "keyUp", keyCode, modifiers: [] },
      ]),
    );
  } finally {
    surface.close?.();
  }
});

it("uses the same native release on hide while preserving character data and other keys", () => {
  const surface = open();
  try {
    surface.human?.input({ type: "keyDown", keyCode: "ArrowDown" });
    surface.human?.input({ type: "char", keyCode: "ArrowDown" });
    surface.human?.input({ type: "keyDown", keyCode: "Enter" });
    surface.human?.input({ type: "char", keyCode: "\r" });
    surface.human?.input({ type: "keyUp", keyCode: "Enter" });
    surface.setVisible(false);
    surface.setVisible(false);
    expect(native.send.mock.calls.map(([event]) => event)).toEqual([
      { type: "keyDown", keyCode: "Down" },
      { type: "char", keyCode: "ArrowDown" },
      { type: "keyDown", keyCode: "Enter" },
      { type: "char", keyCode: "\r" },
      { type: "keyUp", keyCode: "Enter" },
      { type: "keyUp", keyCode: "Down" },
    ]);
  } finally {
    surface.close?.();
  }
});
