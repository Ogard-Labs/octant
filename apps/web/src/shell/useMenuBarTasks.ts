import { useEffect, useMemo, useRef } from "react";
import type { MenuBarTask, OctantHostBridge } from "./hostBridge";
import type { ChatThreadNavigationItem } from "./navigationModel";

export function useMenuBarTasks(options: {
  readonly bridge: Pick<OctantHostBridge, "setMenuBarTasks" | "subscribeMenuBarTask"> | undefined;
  readonly ready: boolean;
  readonly chat: ReadonlyArray<ChatThreadNavigationItem>;
  readonly work: ReadonlyArray<ChatThreadNavigationItem>;
  readonly code: ReadonlyArray<ChatThreadNavigationItem>;
  readonly onSelect: (target: Pick<MenuBarTask, "mode" | "threadId">) => void;
}): void {
  const { bridge, ready, chat, work, code } = options;
  const tasks = useMemo(() => {
    if (!ready) return [];
    const result: MenuBarTask[] = [];
    for (const activity of ["attention", "working", "unread"] as const) {
      for (const [mode, rows] of [
        ["chat", chat],
        ["work", work],
        ["code", code],
      ] as const) {
        for (const row of rows) {
          if (
            row.activity !== activity ||
            result.filter((task) => task.activity === activity).length >= 6
          )
            continue;
          result.push({ mode, threadId: row.threadId, title: row.title.slice(0, 200), activity });
        }
      }
    }
    return result;
  }, [ready, chat, work, code]);
  const latest = useRef({ tasks, onSelect: options.onSelect });
  latest.current = { tasks, onSelect: options.onSelect };
  useEffect(() => {
    void bridge?.setMenuBarTasks?.(tasks).catch(() => undefined);
  }, [bridge, tasks]);
  useEffect(() => {
    const unsubscribe = bridge?.subscribeMenuBarTask?.((target) => {
      if (
        latest.current.tasks.some(
          (task) => task.mode === target.mode && task.threadId === target.threadId,
        )
      ) {
        latest.current.onSelect(target);
      }
    });
    return () => {
      unsubscribe?.();
      void bridge?.setMenuBarTasks?.([]).catch(() => undefined);
    };
  }, [bridge]);
}
