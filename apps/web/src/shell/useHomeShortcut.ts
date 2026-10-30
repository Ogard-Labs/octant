import { matchKeybinding } from "@octant/domain";
import { useEffect, useRef } from "react";
import { useKeybindings } from "../keybindings/useKeybindings";
import { isApplePlatform } from "../platform";

/**
 * Runs `onHome` on the home chord (Mod+Shift+H by default). Like the sidebar
 * chord it answers in a text field too: the chord types nothing, and the
 * composer is where a person most often is when they want to get back.
 */
export function useHomeShortcut(onHome: () => void): void {
  const { keybindings } = useKeybindings();
  // The shell rebuilds its actions every render; reading the latest one here
  // keeps the window listener from being swapped on each of them.
  const latest = useRef(onHome);
  latest.current = onHome;
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (matchKeybinding(keybindings, event, isApplePlatform()) !== "home") return;
      event.preventDefault();
      latest.current();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings]);
}
