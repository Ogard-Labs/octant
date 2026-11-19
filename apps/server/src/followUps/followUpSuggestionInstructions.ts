import { FOLLOW_UP_BLOCK_LANGUAGE, type ProviderContextBlock } from "@octant/contracts";

const SUGGESTIONS_RULE =
  'suggestions lists up to three follow-ups the user could start next, each {"title":"...","prompt":"...","target":"new-thread"}. Offer them only when there is clear, separable next work; most replies leave the list empty. target is "same-thread" (continue here), "new-thread" (a fresh thread in the same Project), or "new-worktree" (Code only: a fresh thread on its own worktree), title is a few words, and prompt stands on its own for a reader with none of this conversation.';

/**
 * How any model predicts the person's next message and offers the next tasks,
 * in every mode and on every provider. Each block is fixed text, with no
 * thread or time in it, so it never breaks a provider's prefix cache; the
 * host decides per thread what each target may create.
 *
 * `next` is required rather than offered: worded as optional ("leave it out
 * when you cannot guess with confidence"), Haiku wrote no block on any of
 * three ordinary prompts and Sonnet on one of three. Worded as required, the
 * two wrote one on seven of eight, the miss being a conversation that had
 * ended (measured 2026-11-18 against both models).
 */
export const FOLLOW_UP_SUGGESTION_INSTRUCTIONS: ProviderContextBlock = {
  kind: "instructions",
  text: [
    "End every reply with one fenced block, after any decision block, in exactly this form:",
    `\`\`\`${FOLLOW_UP_BLOCK_LANGUAGE}`,
    '{"next":"...","suggestions":[]}',
    "```",
    'next is required: the message the user is most likely to send you next, written the way they would type it. Use their voice and one short line, such as "yes, go ahead", "now add tests for that" or "what about on Windows?". Never write it as yourself or as a question to the user. Leave it out only when the conversation is clearly over.',
    SUGGESTIONS_RULE,
    "Neither field sends or creates anything until the user chooses it.",
  ].join("\n"),
};

/**
 * The same block for a mode where the person turned next-message suggestions
 * off: the model is not asked to predict, so it spends no output on a guess
 * the composer would not show.
 */
export const FOLLOW_UP_SUGGESTION_INSTRUCTIONS_WITHOUT_NEXT: ProviderContextBlock = {
  kind: "instructions",
  text: [
    "At the end of a reply you may suggest up to three follow-ups the user could start next, in one fenced block after any decision block, in exactly this form:",
    `\`\`\`${FOLLOW_UP_BLOCK_LANGUAGE}`,
    '{"suggestions":[{"title":"...","prompt":"...","target":"new-thread"}]}',
    "```",
    SUGGESTIONS_RULE,
    "Leave the block out when the list would be empty. A suggestion creates nothing until the user chooses it.",
  ].join("\n"),
};

/** The block for a turn, by whether the person wants its next message predicted. */
export function followUpSuggestionInstructionsFor(
  predictsNextMessage: boolean,
): ProviderContextBlock {
  return predictsNextMessage
    ? FOLLOW_UP_SUGGESTION_INSTRUCTIONS
    : FOLLOW_UP_SUGGESTION_INSTRUCTIONS_WITHOUT_NEXT;
}
