import { useEffect, useRef, useState } from "react";
import type { OctantHostBridge } from "../shell/hostBridge";
import {
  EMPTY_THREAD_ATTENTION,
  evaluateThreadAttention,
  type ThreadAttentionSignal,
} from "./threadAttention";

export interface ThreadAttentionNotificationsInput {
  readonly hostBridge?: OctantHostBridge;
  readonly signals: ReadonlyArray<ThreadAttentionSignal>;
  readonly watchedThreadId?: string;
}

function useWindowFocus(): boolean {
  const [focused, setFocused] = useState(
    () => typeof document === "undefined" || document.hasFocus(),
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const observe = () => setFocused(document.hasFocus() && !document.hidden);
    observe();
    window.addEventListener("focus", observe);
    window.addEventListener("blur", observe);
    document.addEventListener("visibilitychange", observe);
    return () => {
      window.removeEventListener("focus", observe);
      window.removeEventListener("blur", observe);
      document.removeEventListener("visibilitychange", observe);
    };
  }, []);
  return focused;
}

/**
 * Mirrors outstanding thread attention onto the native shell: one banner per
 * newly raised signal, and a dock badge counting the threads still waiting.
 * Both are best-effort — a rejected bridge call must not break the workspace.
 */
export function useThreadAttentionNotifications(input: ThreadAttentionNotificationsInput): void {
  const windowFocused = useWindowFocus();
  const raised = useRef(EMPTY_THREAD_ATTENTION);
  const lastBadgeCount = useRef<number | undefined>(undefined);
  const { hostBridge, signals, watchedThreadId } = input;

  useEffect(() => {
    const outcome = evaluateThreadAttention(
      {
        signals,
        windowFocused,
        ...(watchedThreadId === undefined ? {} : { watchedThreadId }),
      },
      raised.current,
    );
    raised.current = outcome.raised;
    if (hostBridge === undefined) return;
    for (const signal of outcome.announce) {
      void hostBridge
        .notifyAttention?.({
          reason: signal.reason,
          threadTitle: signal.title,
          ...(signal.detail === undefined ? {} : { detail: signal.detail }),
        })
        .catch(() => undefined);
    }
    if (lastBadgeCount.current !== outcome.badgeCount) {
      lastBadgeCount.current = outcome.badgeCount;
      void hostBridge.setAttentionBadge?.(outcome.badgeCount).catch(() => undefined);
    }
  }, [hostBridge, signals, watchedThreadId, windowFocused]);

  useEffect(
    () => () => {
      lastBadgeCount.current = undefined;
      void hostBridge?.setAttentionBadge?.(0).catch(() => undefined);
    },
    [hostBridge],
  );
}
