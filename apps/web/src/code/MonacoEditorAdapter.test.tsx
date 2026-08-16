import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  MonacoEditorAdapter,
  type MonacoAdapterRuntime,
  type MonacoAdapterSession,
} from "./MonacoEditorAdapter";

describe("MonacoEditorAdapter", () => {
  it("renders an actionable unavailable state when the runtime cannot load", async () => {
    render(
      <MonacoEditorAdapter
        ariaLabel="README.md editor"
        language="markdown"
        loadRuntime={vi.fn(async () => {
          throw new Error("chunk unavailable");
        })}
        modelUri="octant-code://checkout-opaque/file-opaque"
        onChange={vi.fn()}
        readOnly
        value=""
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The Code editor engine is unavailable. Retry this tab.",
    );
  });

  it("mounts with the latest controlled state when the runtime resolves late", async () => {
    const runtime = deferred<MonacoAdapterRuntime>();
    const mount = vi.fn<MonacoAdapterRuntime["mount"]>(() => session());
    const props = {
      ariaLabel: "README.md editor",
      language: "markdown",
      loadRuntime: vi.fn(() => runtime.promise),
      modelUri: "octant-code://checkout-opaque/file-opaque",
      onChange: vi.fn(),
    } as const;
    const { rerender } = render(<MonacoEditorAdapter {...props} readOnly={false} value="stale" />);

    rerender(<MonacoEditorAdapter {...props} readOnly value="latest" />);
    await act(async () => runtime.resolve({ mount }));

    expect(mount).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ readOnly: true, value: "latest" }),
    );
  });

  it("mounts one opaque model session, updates controlled state, focuses, and disposes", async () => {
    const session: MonacoAdapterSession = {
      dispose: vi.fn(),
      focus: vi.fn(),
      setReadOnly: vi.fn(),
      setValue: vi.fn(),
    };
    const mount = vi.fn<MonacoAdapterRuntime["mount"]>(() => session);
    const runtime: MonacoAdapterRuntime = { mount };
    const loadRuntime = vi.fn(async () => runtime);
    const onChange = vi.fn();
    const { rerender, unmount } = render(
      <MonacoEditorAdapter
        ariaLabel="README.md editor"
        language="markdown"
        loadRuntime={loadRuntime}
        modelUri="octant-code://checkout-opaque/file-opaque"
        onChange={onChange}
        readOnly={false}
        value="first"
      />,
    );

    await act(async () => void (await loadRuntime.mock.results[0]?.value));
    expect(runtime.mount).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({
        language: "markdown",
        modelUri: "octant-code://checkout-opaque/file-opaque",
        onChange: expect.any(Function),
        readOnly: false,
        value: "first",
      }),
    );
    mount.mock.calls[0]![1].onChange("changed");
    expect(onChange).toHaveBeenCalledWith("changed");

    screen.getByRole("region", { name: "README.md editor" }).focus();
    expect(session.focus).toHaveBeenCalledOnce();
    rerender(
      <MonacoEditorAdapter
        ariaLabel="README.md editor"
        language="markdown"
        loadRuntime={loadRuntime}
        modelUri="octant-code://checkout-opaque/file-opaque"
        onChange={onChange}
        readOnly
        value="second"
      />,
    );
    expect(session.setValue).toHaveBeenLastCalledWith("second");
    expect(session.setReadOnly).toHaveBeenLastCalledWith(true);

    unmount();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("passes and updates the independent editor typography projection", async () => {
    const session: MonacoAdapterSession = {
      dispose: vi.fn(),
      focus: vi.fn(),
      setReadOnly: vi.fn(),
      setTypography: vi.fn(),
      setValue: vi.fn(),
    };
    const mount = vi.fn<MonacoAdapterRuntime["mount"]>(() => session);
    const loadRuntime = vi.fn(async () => ({ mount }));
    const first = {
      fontFamily: "Source Code Pro",
      fontSize: 15,
      fontWeight: 500,
      lineHeight: 1.8,
      fontLigatures: false,
    } as const;
    const second = { ...first, fontSize: 16 };
    const { rerender } = render(
      <MonacoEditorAdapter
        ariaLabel="README.md editor"
        language="markdown"
        loadRuntime={loadRuntime}
        modelUri="octant-code://checkout-opaque/file-opaque"
        onChange={vi.fn()}
        readOnly
        typography={first}
        value="first"
      />,
    );
    await act(async () => void (await loadRuntime.mock.results[0]?.value));
    expect(mount).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ typography: first }),
    );
    rerender(
      <MonacoEditorAdapter
        ariaLabel="README.md editor"
        language="markdown"
        loadRuntime={loadRuntime}
        modelUri="octant-code://checkout-opaque/file-opaque"
        onChange={vi.fn()}
        readOnly
        typography={second}
        value="first"
      />,
    );
    expect(session.setTypography).toHaveBeenLastCalledWith(second);
  });
});

function session(): MonacoAdapterSession {
  return {
    dispose: vi.fn(),
    focus: vi.fn(),
    setReadOnly: vi.fn(),
    setValue: vi.fn(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
