import { useEffect, useRef } from "react";
import type { MenuBarOpenThread, OctantHostBridge } from "./hostBridge";

/**
 * Keeps the desktop menu bar told which thread this window shows, so a thread
 * that finished stops reading as done once the person opens it, and opens the
 * thread a menu-bar row names. The roster itself comes from the host, not from
 * this window: the menu bar has to work with every window closed.
 */
export function useMenuBarThread(options: {
  readonly bridge:
    | Pick<OctantHostBridge, "setMenuBarOpenThread" | "subscribeMenuBarTask">
    | undefined;
  /** The window can open a thread it is asked for. */
  readonly ready: boolean;
  readonly open: MenuBarOpenThread | undefined;
  readonly onSelect: (target: MenuBarOpenThread) => void;
}): void {
  const { bridge, ready } = options;
  const mode = options.open?.mode;
  const threadId = options.open?.threadId;
  const onSelect = useRef(options.onSelect);
  onSelect.current = options.onSelect;
  const readyNow = useRef(ready);
  readyNow.current = ready;
  // A pick that lands while the window cannot open threads (its host
  // connection dropped without a reload) waits here instead of being lost.
  const waiting = useRef<MenuBarOpenThread | undefined>(undefined);
  // Declared first so the listener exists before the first report: the shell
  // treats that report as this window being ready for a row it was asked to open.
  useEffect(() => {
    const unsubscribe = bridge?.subscribeMenuBarTask?.((target) => {
      if (readyNow.current) onSelect.current(target);
      else waiting.current = target;
    });
    return () => {
      unsubscribe?.();
      void bridge?.setMenuBarOpenThread?.(null).catch(() => undefined);
    };
  }, [bridge]);
  useEffect(() => {
    if (!ready) return;
    const pending = waiting.current;
    waiting.current = undefined;
    if (pending !== undefined) onSelect.current(pending);
    const thread = mode === undefined || threadId === undefined ? null : { mode, threadId };
    void bridge?.setMenuBarOpenThread?.(thread).catch(() => undefined);
  }, [bridge, ready, mode, threadId]);
}
