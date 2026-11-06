import { matchKeybinding } from "@octant/domain";
import { useEffect, useRef } from "react";
import { useKeybindings } from "../keybindings/useKeybindings";
import { isApplePlatform } from "../platform";

/**
 * Runs `onCycle` on the reply detail chord (Mod+Shift+D by default). It answers
 * in a text field too, like the jump chord: it types nothing, and the composer
 * is where a person reading a thread usually is. `onCycle` says whether there
 * was a thread to change; only then is the browser's own use of the chord
 * prevented, so outside a thread the chord keeps whatever it meant before.
 */
export function useReplyDetailShortcut(onCycle: () => boolean): void {
  const { keybindings } = useKeybindings();
  const latest = useRef(onCycle);
  latest.current = onCycle;
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (matchKeybinding(keybindings, event, isApplePlatform()) !== "reply-detail-cycle") return;
      if (latest.current()) event.preventDefault();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings]);
}
