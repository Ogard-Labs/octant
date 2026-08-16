import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  XtermTerminalAdapter,
  type XtermAdapterRuntime,
  type XtermAdapterSession,
} from "./XtermTerminalAdapter";

describe("XtermTerminalAdapter", () => {
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
