// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useMenuBarThread } from "./useMenuBarThread";
import type { MenuBarOpenThread, OctantHostBridge } from "./hostBridge";

it("listens before it reports the open thread, opens what the menu bar picks, and clears on unmount", () => {
  const calls: string[] = [];
  let select: ((target: MenuBarOpenThread) => void) | undefined;
  const setMenuBarOpenThread = vi.fn(async (thread: MenuBarOpenThread | null) => {
    calls.push(`report:${thread === null ? "none" : thread.threadId}`);
  });
  const unsubscribe = vi.fn();
  const bridge = {
    setMenuBarOpenThread,
    subscribeMenuBarTask: (listener: (target: MenuBarOpenThread) => void) => {
      calls.push("listen");
      select = listener;
      return unsubscribe;
    },
  } satisfies Partial<OctantHostBridge>;
  const onSelect = vi.fn();
  const initialProps: { readonly ready: boolean; readonly open: MenuBarOpenThread | undefined } = {
    ready: false,
    open: undefined,
  };
  const { rerender, unmount } = renderHook(
    (props: typeof initialProps) =>
      useMenuBarThread({ bridge, ready: props.ready, open: props.open, onSelect }),
    { initialProps },
  );
  // Nothing is reported until the window can open a thread it is asked for.
  expect(setMenuBarOpenThread).not.toHaveBeenCalled();
  rerender({ ready: true, open: undefined });
  expect(calls).toEqual(["listen", "report:none"]);
  rerender({ ready: true, open: { mode: "code", threadId: "b" } });
  expect(setMenuBarOpenThread).toHaveBeenLastCalledWith({ mode: "code", threadId: "b" });
  act(() => select?.({ mode: "work", threadId: "w" }));
  expect(onSelect).toHaveBeenCalledWith({ mode: "work", threadId: "w" });
  unmount();
  expect(setMenuBarOpenThread).toHaveBeenLastCalledWith(null);
  expect(unsubscribe).toHaveBeenCalled();
});
