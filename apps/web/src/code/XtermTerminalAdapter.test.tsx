import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  XtermTerminalAdapter,
  type XtermAdapterRuntime,
  type XtermAdapterSession,
} from "./XtermTerminalAdapter";

describe("XtermTerminalAdapter", () => {
  describe("leaving the terminal from the keyboard", () => {
    async function mountBetweenControls() {
      const mount = vi.fn<XtermAdapterRuntime["mount"]>(() => session());
      const onData = vi.fn();
      const loadRuntime = vi.fn(async () => ({ mount }));
      render(
        <>
          <button type="button">Before</button>
          <XtermTerminalAdapter
            ariaLabel="Repository terminal"
            interactive
            loadRuntime={loadRuntime}
            onData={onData}
            onResize={vi.fn()}
            output=""
          />
          <button type="button">After</button>
        </>,
      );
      await act(async () => void (await loadRuntime.mock.results[0]?.value));
      const interceptKey = mount.mock.calls[0]![1].interceptKey!;
      return { interceptKey, onData };
    }
    const press = (key: string, init: KeyboardEventInit = {}) =>
      new KeyboardEvent("keydown", { key, cancelable: true, ...init });

    it("moves focus to the next control on the chord and to the previous one with Shift", async () => {
      const { interceptKey, onData } = await mountBetweenControls();
      const terminal = screen.getByRole("region", { name: "Repository terminal" });
      terminal.focus();

      const next = press("Escape", { ctrlKey: true });
      expect(interceptKey(next)).toBe(true);
      expect(next.defaultPrevented).toBe(true);
      expect(screen.getByRole("button", { name: "After" })).toHaveFocus();

      terminal.focus();
      expect(interceptKey(press("Escape", { ctrlKey: true, shiftKey: true }))).toBe(true);
      expect(screen.getByRole("button", { name: "Before" })).toHaveFocus();
      expect(onData).not.toHaveBeenCalled();
    });

    it("claims the chord's release too, without moving focus a second time", async () => {
      const { interceptKey } = await mountBetweenControls();
      screen.getByRole("button", { name: "After" }).focus();

      const release = new KeyboardEvent("keyup", { key: "Escape", ctrlKey: true });
      expect(interceptKey(release)).toBe(true);
      expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
    });

    it("leaves Tab, Shift+Tab and a bare Escape to the shell", async () => {
      const { interceptKey } = await mountBetweenControls();
      const terminal = screen.getByRole("region", { name: "Repository terminal" });
      terminal.focus();

      for (const event of [
        press("Tab"),
        press("Tab", { shiftKey: true }),
        press("Escape"),
        press("F6"),
        press("`", { ctrlKey: true }),
      ]) {
        expect(interceptKey(event)).toBe(false);
        expect(event.defaultPrevented).toBe(false);
      }
      expect(terminal).toHaveFocus();
    });

    it("names no chord that another action already owns, and still points to a way out", async () => {
      localStorage.setItem(
        "octant.keybindings.v1",
        JSON.stringify({ "terminal-focus-next": "Mod+K", "terminal-focus-previous": "Mod+K" }),
      );
      try {
        const { interceptKey } = await mountBetweenControls();
        const terminal = screen.getByRole("region", { name: "Repository terminal" });
        const hint = terminal.getAttribute("aria-describedby");
        const text = document.getElementById(hint ?? "")?.textContent ?? "";

        expect(text).toBe(
          "The chord that leaves the terminal is taken by another action; Ctrl+K opens the command palette",
        );
        expect(text).not.toMatch(/leaves the terminal$/);
        expect(text).not.toMatch(/goes back/);
        // The chord belongs to the palette, so the terminal does not claim it either.
        expect(interceptKey(press("k", { ctrlKey: true }))).toBe(false);
      } finally {
        localStorage.removeItem("octant.keybindings.v1");
      }
    });

    it("still names the previous-control chord when only the next-control chord is taken", async () => {
      localStorage.setItem(
        "octant.keybindings.v1",
        JSON.stringify({ "terminal-focus-next": "Mod+K" }),
      );
      try {
        await mountBetweenControls();
        const terminal = screen.getByRole("region", { name: "Repository terminal" });
        const text =
          document.getElementById(terminal.getAttribute("aria-describedby") ?? "")?.textContent ??
          "";

        expect(text).toBe(
          "The chord that leaves the terminal is taken by another action; Ctrl+K opens the command palette · Ctrl+Shift+Escape goes back",
        );
      } finally {
        localStorage.removeItem("octant.keybindings.v1");
      }
    });

    it("tells keyboard users the chord while the terminal holds the keyboard", async () => {
      await mountBetweenControls();
      const terminal = screen.getByRole("region", { name: "Repository terminal" });
      const hint = screen.getByText(/leaves the terminal/);

      expect(terminal).toHaveAccessibleDescription(hint.textContent ?? "");
      expect(hint).toHaveAttribute("data-visible", "false");
      act(() => terminal.focus());
      expect(hint).toHaveAttribute("data-visible", "true");
      act(() => screen.getByRole("button", { name: "After" }).focus());
      expect(hint).toHaveAttribute("data-visible", "false");
    });
  });

  it("renders an actionable unavailable state when the runtime cannot load", async () => {
    render(
      <XtermTerminalAdapter
        ariaLabel="Repository terminal"
        interactive={false}
        loadRuntime={vi.fn(async () => {
          throw new Error("chunk unavailable");
        })}
        onData={vi.fn()}
        onResize={vi.fn()}
        output=""
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The Code terminal engine is unavailable. Retry this tab.",
    );
  });

  it("mounts with the latest replay and interaction state when the runtime resolves late", async () => {
    const runtime = deferred<XtermAdapterRuntime>();
    const mount = vi.fn<XtermAdapterRuntime["mount"]>(() => session());
    const props = {
      ariaLabel: "Repository terminal",
      loadRuntime: vi.fn(() => runtime.promise),
      onData: vi.fn(),
      onResize: vi.fn(),
    } as const;
    const { rerender } = render(
      <XtermTerminalAdapter {...props} interactive={false} output="stale" />,
    );

    rerender(<XtermTerminalAdapter {...props} interactive output="latest" />);
    await act(async () => runtime.resolve({ mount }));

    expect(mount).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ interactive: true, output: "latest" }),
    );
  });

  it("mounts a renderer-only terminal, updates replay and interaction, focuses, and disposes", async () => {
    const session: XtermAdapterSession = {
      dispose: vi.fn(),
      focus: vi.fn(),
      setInteractive: vi.fn(),
      setOutput: vi.fn(),
    };
    const mount = vi.fn<XtermAdapterRuntime["mount"]>(() => session);
    const runtime: XtermAdapterRuntime = { mount };
    const loadRuntime = vi.fn(async () => runtime);
    const onData = vi.fn();
    const onResize = vi.fn();
    const { rerender, unmount } = render(
      <XtermTerminalAdapter
        ariaLabel="Repository terminal"
        interactive={false}
        loadRuntime={loadRuntime}
        onData={onData}
        onResize={onResize}
        output="first"
      />,
    );

    await act(async () => void (await loadRuntime.mock.results[0]?.value));
    expect(runtime.mount).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({
        interactive: false,
        onData: expect.any(Function),
        onResize: expect.any(Function),
        output: "first",
      }),
    );
    mount.mock.calls[0]![1].onData("input");
    mount.mock.calls[0]![1].onResize(120, 40);
    expect(onData).toHaveBeenCalledWith("input");
    expect(onResize).toHaveBeenCalledWith(120, 40);

    screen.getByRole("region", { name: "Repository terminal" }).focus();
    expect(session.focus).toHaveBeenCalledOnce();
    rerender(
      <XtermTerminalAdapter
        ariaLabel="Repository terminal"
        interactive
        loadRuntime={loadRuntime}
        onData={onData}
        onResize={onResize}
        output="second"
      />,
    );
    expect(session.setOutput).toHaveBeenLastCalledWith("second");
    expect(session.setInteractive).toHaveBeenLastCalledWith(true);

    unmount();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("passes and updates the independent terminal typography projection", async () => {
    const session: XtermAdapterSession = {
      dispose: vi.fn(),
      focus: vi.fn(),
      setInteractive: vi.fn(),
      setOutput: vi.fn(),
      setTypography: vi.fn(),
    };
    const mount = vi.fn<XtermAdapterRuntime["mount"]>(() => session);
    const loadRuntime = vi.fn(async () => ({ mount }));
    const first = {
      fontFamily: "JetBrains Mono",
      fontSize: 12,
      fontWeight: 300,
      lineHeight: 1.3,
      fontLigatures: true,
    } as const;
    const second = { ...first, fontSize: 13 };
    const { rerender } = render(
      <XtermTerminalAdapter
        ariaLabel="Repository terminal"
        interactive
        loadRuntime={loadRuntime}
        onData={vi.fn()}
        onResize={vi.fn()}
        output="first"
        typography={first}
      />,
    );
    await act(async () => void (await loadRuntime.mock.results[0]?.value));
    expect(mount).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ typography: first }),
    );
    rerender(
      <XtermTerminalAdapter
        ariaLabel="Repository terminal"
        interactive
        loadRuntime={loadRuntime}
        onData={vi.fn()}
        onResize={vi.fn()}
        output="first"
        typography={second}
      />,
    );
    expect(session.setTypography).toHaveBeenLastCalledWith(second);
  });
});

function session(): XtermAdapterSession {
  return {
    dispose: vi.fn(),
    focus: vi.fn(),
    setInteractive: vi.fn(),
    setOutput: vi.fn(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
