import type { OctantKeybindingActionId } from "@octant/domain";

/**
 * Commands that share an action with a user-bindable chord.
 *
 * Most palette rows are navigation and have no chord. The ids here are the
 * ones the host already binds in `OctantKeybindings`; the palette only
 * displays the chord that is actually in effect.
 */
const COMMAND_KEYBINDING_ACTIONS: Readonly<Partial<Record<string, OctantKeybindingActionId>>> = {
  "workspace:zen-mode": "zen-mode",
  "workspace:context-usage": "context-usage",
  "code:file-search": "code-file-search",
  "code:content-search": "code-content-search",
};

export function keybindingActionForCommand(
  commandId: string,
): OctantKeybindingActionId | undefined {
  return COMMAND_KEYBINDING_ACTIONS[commandId];
}
