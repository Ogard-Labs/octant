import { describeChord, type OctantKeybindingActionId } from "@octant/domain";
import { isApplePlatform } from "../platform";
import { useKeybindings } from "./useKeybindings";

/**
 * How the chord now bound to an action reads on this keyboard ("⌘N"), or
 * `undefined` when the person has unbound it, so a control never advertises a
 * key that does nothing.
 */
export function useActionShortcut(actionId: OctantKeybindingActionId): string | undefined {
  const { keybindings } = useKeybindings();
  const chord = keybindings.bindings.get(actionId);
  return chord === undefined ? undefined : describeChord(chord, isApplePlatform());
}
