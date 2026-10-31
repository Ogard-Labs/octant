import { matchKeybinding } from "@octant/domain";
import { useEffect, useRef } from "react";
import { useKeybindings } from "../keybindings/useKeybindings";
import { isApplePlatform } from "../platform";

/**
 * Runs `onJump` on the next-waiting-thread chord (Mod+Shift+J by default). Like
 * the home chord it answers in a text field too: the chord types nothing, and
 * the composer is where a person most often is when an agent needs them.
 */
export function useJumpToWaitingShortcut(onJump: () => void): void {
  const { keybindings } = useKeybindings();
  // The shell rebuilds its actions every render; reading the latest one here
  // keeps the window listener from being swapped on each of them.
  const latest = useRef(onJump);
  latest.current = onJump;
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (matchKeybinding(keybindings, event, isApplePlatform()) !== "next-waiting-thread") return;
      event.preventDefault();
      latest.current();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings]);
}
