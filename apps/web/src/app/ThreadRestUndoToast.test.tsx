import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isApplePlatform } from "../platform";
import {
  takesThreadRestUndoChord,
  ThreadRestUndoHost,
  ThreadRestUndoToast,
  THREAD_REST_UNDO_MS,
} from "./ThreadRestUndoToast";
import { threadRestUndoStore } from "./threadRestUndoStore";

afterEach(() => vi.useRealTimers());

function renderToast() {
  const undo = vi.fn();
  const onDismiss = vi.fn();
  render(
    <>
      <textarea aria-label="Message" />
      <ThreadRestUndoToast
        notice={{ sequence: 1, title: "Settled", detail: "Plan", undo }}
        onDismiss={onDismiss}
      />
    </>,
  );
  return { undo, onDismiss };
}

describe("the sidebar Undo notice", () => {
  it("undoes from its button and leaves after five seconds", () => {
    vi.useFakeTimers();
    const { undo, onDismiss } = renderToast();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(THREAD_REST_UNDO_MS));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("Mod+Z in the composer stays the editor's undo", () => {
    const { undo } = renderToast();
    const composer = screen.getByRole("textbox", { name: "Message" });
    fireEvent.keyDown(composer, { key: "z", metaKey: true, ctrlKey: true });
    fireEvent.keyDown(composer, { key: "z", metaKey: true });
    fireEvent.keyDown(composer, { key: "z", ctrlKey: true });
    expect(undo).not.toHaveBeenCalled();
  });

  it("takes Mod+Z outside text while it shows", () => {
    expect(
      takesThreadRestUndoChord(
        {
          key: "z",
          metaKey: true,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          target: document.body,
        },
        true,
      ),
    ).toBe(true);
    expect(
      takesThreadRestUndoChord(
        {
          key: "z",
          metaKey: false,
          ctrlKey: true,
          shiftKey: false,
          altKey: false,
          target: document.body,
        },
        false,
      ),
    ).toBe(true);
    // Mod+Shift+Z is redo, and a terminal keeps its keys.
    expect(
      takesThreadRestUndoChord(
        {
          key: "Z",
          metaKey: true,
          ctrlKey: false,
          shiftKey: true,
          altKey: false,
          target: document.body,
        },
        true,
      ),
    ).toBe(false);
    const terminal = document.createElement("div");
    terminal.className = "xterm";
    const inner = document.createElement("div");
    terminal.append(inner);
    expect(
      takesThreadRestUndoChord(
        { key: "z", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, target: inner },
        true,
      ),
    ).toBe(false);
    const { undo } = renderToast();
    fireEvent.keyDown(document.body, { key: "z", metaKey: true, ctrlKey: true });
    expect(undo).not.toHaveBeenCalled();
  });

  it("runs Undo on a plain Mod+Z outside text while it shows", () => {
    const { undo } = renderToast();
    const apple = isApplePlatform();
    fireEvent.keyDown(
      document.body,
      apple ? { key: "z", metaKey: true } : { key: "z", ctrlKey: true },
    );
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("drops an offered Undo when the window moves to another host or closes", () => {
    const view = render(<ThreadRestUndoHost hostKey="http://127.0.0.1:4000" />);
    act(() =>
      threadRestUndoStore.offer({
        sequence: 1_000,
        title: "Settled",
        detail: "Plan",
        undo: vi.fn(),
      }),
    );
    expect(screen.getByRole("button", { name: "Undo" })).toBeVisible();
    view.rerender(<ThreadRestUndoHost hostKey="https://other-host.example" />);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    act(() =>
      threadRestUndoStore.offer({
        sequence: 1_001,
        title: "Pinned",
        detail: "Plan",
        undo: vi.fn(),
      }),
    );
    view.unmount();
    expect(threadRestUndoStore.current()).toBeUndefined();
  });
  it("offers no Undo for a change its old host answers after the window moved", async () => {
    // A fresh window: earlier tests' notices raised the store's newest number.
    vi.resetModules();
    const { threadRestRowActions } = await import("./threadRestRowActions");
    const { ThreadRestUndoHost } = await import("./ThreadRestUndoToast");
    const answers: Array<(outcome: { readonly status: "ok" }) => void> = [];
    const completeCodeThread = vi.fn(
      () => new Promise<{ readonly status: "ok" }>((resolve) => answers.push(resolve)),
    );
    const actions = threadRestRowActions({
      threadRestRow: () => ({ title: "Plan" }),
      setThreadExportNotice: vi.fn(),
      completeCodeThread,
    } as never);
    const view = render(<ThreadRestUndoHost hostKey="http://127.0.0.1:4000" />);
    const settle = async (count: number) => {
      actions.code.onCompleteThread?.("00000000-0000-4000-8000-0000000000c1");
      await vi.waitFor(() => expect(completeCodeThread).toHaveBeenCalledTimes(count), {
        timeout: 5_000,
      });
    };

    await settle(1);
    await act(async () => answers[0]?.({ status: "ok" }));
    expect(screen.getByRole("button", { name: "Undo" })).toBeVisible();

    await settle(2);
    view.rerender(<ThreadRestUndoHost hostKey="https://other-host.example" />);
    await act(async () => answers[1]?.({ status: "ok" }));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    view.unmount();
  });
});
