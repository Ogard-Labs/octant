// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useMenuBarTasks } from "./useMenuBarTasks";
import type { MenuBarTask, OctantHostBridge } from "./hostBridge";

it("publishes active tasks, resumes the selected task, and clears the window on unmount", async () => {
  let select: ((target: Pick<MenuBarTask, "mode" | "threadId">) => void) | undefined;
  const setMenuBarTasks = vi.fn(async () => {});
  const unsubscribe = vi.fn();
  const bridge = {
    setMenuBarTasks,
    subscribeMenuBarTask: (listener: typeof select) => {
      select = listener;
      return unsubscribe;
    },
  } satisfies Partial<OctantHostBridge>;
  const onSelect = vi.fn();
  const { unmount } = renderHook(() =>
    useMenuBarTasks({
      bridge,
      ready: true,
      chat: [{ threadId: "a", title: "Answer question", activity: "working" }],
      work: [],
      code: [
        { threadId: "b", title: "Review changes", activity: "attention" },
        { threadId: "c", title: "Idle task", activity: "idle" },
      ],
      onSelect,
    }),
  );
  await waitFor(() =>
    expect(setMenuBarTasks).toHaveBeenCalledWith([
      { mode: "code", threadId: "b", title: "Review changes", activity: "attention" },
      { mode: "chat", threadId: "a", title: "Answer question", activity: "working" },
    ]),
  );
  act(() => select?.({ mode: "code", threadId: "b" }));
  expect(onSelect).toHaveBeenCalledWith({ mode: "code", threadId: "b" });
  act(() => select?.({ mode: "code", threadId: "missing" }));
  expect(onSelect).toHaveBeenCalledTimes(1);
  unmount();
  expect(setMenuBarTasks).toHaveBeenLastCalledWith([]);
  expect(unsubscribe).toHaveBeenCalled();
});
