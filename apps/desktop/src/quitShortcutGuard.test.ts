import { describe, expect, it, vi } from "vitest";
import { QUIT_SHORTCUT_WINDOW_MS, createQuitShortcutGuard } from "./quitShortcutGuard";

function setup(showsNotice = true) {
  let clock = 10_000;
  const showNotice = vi.fn(() => showsNotice);
  const quit = vi.fn();
  const guard = createQuitShortcutGuard({ now: () => clock, showNotice, quit });
  return {
    guard,
    showNotice,
    quit,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("quit shortcut guard", () => {
  it("shows the notice and does not quit on the first shortcut press", () => {
    const { guard, showNotice, quit } = setup();
    guard.request({ viaShortcut: true });
    expect(showNotice).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();
  });

  it("quits on a second press inside the window", () => {
    const { guard, showNotice, quit, advance } = setup();
    guard.request({ viaShortcut: true });
    advance(QUIT_SHORTCUT_WINDOW_MS);
    guard.request({ viaShortcut: true });
    expect(quit).toHaveBeenCalledOnce();
    expect(showNotice).toHaveBeenCalledOnce();
  });

  it("counts a press after the window as a new first press", () => {
    const { guard, showNotice, quit, advance } = setup();
    guard.request({ viaShortcut: true });
    advance(QUIT_SHORTCUT_WINDOW_MS + 1);
    guard.request({ viaShortcut: true });
    expect(quit).not.toHaveBeenCalled();
    expect(showNotice).toHaveBeenCalledTimes(2);
  });

  it("needs two fresh presses again after a confirmed quit request", () => {
    const { guard, quit } = setup();
    guard.request({ viaShortcut: true });
    guard.request({ viaShortcut: true });
    guard.request({ viaShortcut: true });
    expect(quit).toHaveBeenCalledOnce();
  });

  it("quits at once for a menu click", () => {
    const { guard, showNotice, quit } = setup();
    guard.request({ viaShortcut: false });
    expect(quit).toHaveBeenCalledOnce();
    expect(showNotice).not.toHaveBeenCalled();
  });

  it("quits on the first press when no window can show the notice", () => {
    const { guard, quit } = setup(false);
    guard.request({ viaShortcut: true });
    expect(quit).toHaveBeenCalledOnce();
  });
});
