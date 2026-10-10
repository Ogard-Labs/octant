import {
  MAX_TURN_DECISION_ASK_LENGTH,
  MAX_TURN_DECISION_OPTION_LENGTH,
  MAX_TURN_DECISION_OPTIONS,
  TURN_DECISION_BLOCK_LANGUAGE,
  type OctantMode,
  type ProviderContextBlock,
} from "@octant/contracts";

/**
 * How any model hands the person a decision when a Work or Code turn cannot
 * go on without one. One fixed block with no thread, time, or provider in it,
 * so it never breaks a provider's prefix cache. The host reads the block from
 * the normalized reply; it is the only way a decision is raised, and an option
 * is only ever the words of the next turn.
 */
export const TURN_DECISION_INSTRUCTIONS: ProviderContextBlock = {
  kind: "instructions",
  text: [
    "When you finish a turn and the work cannot continue until the user chooses between a few concrete next steps, end the reply with exactly this block as its last thing (before any follow-up block):",
    `\`\`\`${TURN_DECISION_BLOCK_LANGUAGE}`,
    '{"ask":"...","options":[{"label":"...","recommended":true},{"label":"..."}]}',
    "```",
    `ask is one sentence of at most ${String(MAX_TURN_DECISION_ASK_LENGTH)} characters. Give 1 to ${String(MAX_TURN_DECISION_OPTIONS)} options of at most ${String(MAX_TURN_DECISION_OPTION_LENGTH)} characters each, written as the words the user would reply with, and mark exactly one recommended. Picking an option only sends its words to you as the next message; it does nothing else. Leave the block out when the work is finished or nothing needs the user's choice.`,
  ].join("\n"),
};

/** Chat has no decisions: only Work and Code turns are asked for the block. */
export function turnDecisionInstructions(mode: OctantMode): ReadonlyArray<ProviderContextBlock> {
  return mode === "chat" ? [] : [TURN_DECISION_INSTRUCTIONS];
}
