import { matchKeybinding } from "@octant/domain";
import { useEffect } from "react";
import { useKeybindings } from "../keybindings/useKeybindings";
import { isApplePlatform } from "../platform";

/**
 * Runs `onToggle` on the sidebar chord (Mod+Backslash by default). It answers in a
 * text field too: the chord types nothing, and hiding the sidebar while
 * writing is exactly when a person wants the room.
 */
export function useSidebarToggleShortcut(onToggle: () => void): void {
  const { keybindings } = useKeybindings();
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (matchKeybinding(keybindings, event, isApplePlatform()) !== "toggle-sidebar") return;
      event.preventDefault();
      onToggle();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, onToggle]);
}
