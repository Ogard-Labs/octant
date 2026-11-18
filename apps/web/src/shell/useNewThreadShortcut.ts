import { matchKeybinding } from "@octant/domain";
import { useEffect, useRef } from "react";
import { useKeybindings } from "../keybindings/useKeybindings";
import { isApplePlatform } from "../platform";

/**
 * Runs `onNewThread` on the new-thread chord (Mod+N by default). It answers in
 * a text field too: the chord types nothing, and the composer is where a person
 * most often is when they decide to start over.
 */
export function useNewThreadShortcut(onNewThread: () => void): void {
  const { keybindings } = useKeybindings();
  // The shell rebuilds its actions every render; reading the latest one here
  // keeps the window listener from being swapped on each of them.
  const latest = useRef(onNewThread);
  latest.current = onNewThread;
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (matchKeybinding(keybindings, event, isApplePlatform()) !== "new-thread") return;
      event.preventDefault();
      latest.current();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings]);
}
